-- 0020: publish queue (CF-24, docs/06-workflows/PUBLISH_QUEUE.md section 16 is the source of truth).
-- publish_jobs is read-only for clients. Every change goes through four security definer RPCs that run with the
-- caller's session (auth.uid()), never a service role. The article state table (0002) is not changed:
-- the RPCs only make transitions that table already allows (export_ready/publish_failed -> publishing ->
-- draft_created/publish_failed). Numbers (5 min stale, 3 running per workspace, 50 queued, 6 attempts) are hypotheses.
-- Never call set_config('role', ...) or SET ROLE in these functions: cf_caller_is_client() (0019) reads the role GUC.

create table publish_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  article_id uuid not null,
  approved_version_id uuid not null,
  channel text not null default 'wordpress' check (channel in ('wordpress')),
  remote_key text not null check (length(btrim(remote_key)) between 1 and 500),
  idempotency_key text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'draft_created', 'succeeded', 'failed', 'needs_attention', 'cancelled')),
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 6 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by uuid references auth.users (id) on delete set null,
  last_error text check (length(last_error) <= 500),
  cancel_reason text check (length(cancel_reason) <= 100),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, article_id) references articles (workspace_id, id) on delete cascade,
  foreign key (workspace_id, approved_version_id) references article_versions (workspace_id, id) on delete cascade,
  check (status <> 'running' or locked_at is not null)
);
comment on table publish_jobs is 'Publish queue jobs. Members read, clients never write: only the queue RPCs (security definer) do.';
comment on column publish_jobs.idempotency_key is 'workspace_id:article_id:approved_version_id. Record only, not unique (section 16).';

-- One open job per article. One running job per remote site across all workspaces is enforced by claim_publish_job
-- (advisory lock per remote_key), not by a unique index: a running job older than the stale limit of another
-- workspace is left as it is (its owner reclaims it) but must not block the site, and an index can not use now().
create unique index publish_jobs_article_open_uq on publish_jobs (article_id) where status in ('queued', 'running', 'needs_attention');
create index publish_jobs_remote_running_idx on publish_jobs (remote_key) where status = 'running';
create index publish_jobs_status_due_idx on publish_jobs (status, next_attempt_at);
create index publish_jobs_ws_status_idx on publish_jobs (workspace_id, status);

alter table publish_jobs enable row level security;
create policy publish_jobs_select on publish_jobs for select to authenticated using (is_member(workspace_id));
-- No write policies, and no write privileges either (Supabase grants them by default).
revoke all on publish_jobs from anon, authenticated;
grant select on publish_jobs to authenticated;

-- ---------- enqueue ----------
-- Returns the job (an existing open job of the same approved version is returned with duplicate = true).
create function enqueue_publish_job(p_article_id uuid, p_remote_key text)
returns table (job_id uuid, status text, duplicate boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  ws uuid;
  a articles;
  vid uuid;
  ex publish_jobs;
  nid uuid;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN_ROLE'; end if;
  select workspace_id into ws from articles where id = p_article_id;
  if not found or not is_member(ws, array['owner','admin','editor']::workspace_role[]) then
    raise exception 'FORBIDDEN_ROLE';
  end if;
  if p_remote_key is null or length(btrim(p_remote_key)) not between 1 and 500 then
    raise exception 'REMOTE_KEY_INVALID';
  end if;
  select * into a from articles where id = p_article_id for update;
  if a.state not in ('export_ready', 'publish_failed') then raise exception 'QUEUE_NOT_APPROVED'; end if;
  select v.id into vid from article_versions v where v.article_id = a.id order by v.version desc limit 1;
  if vid is null then raise exception 'QUEUE_NOT_APPROVED'; end if;

  select * into ex from publish_jobs j where j.article_id = a.id and j.status in ('queued', 'running', 'needs_attention');
  if found then
    if ex.approved_version_id = vid then
      -- Sending again is the person's answer to needs_attention (e.g. fixed credentials): back to the queue.
      if ex.status = 'needs_attention' then
        update publish_jobs set status = 'queued', attempts = 0, next_attempt_at = now(), last_error = null,
          updated_at = now() where id = ex.id;
        return query select ex.id, 'queued'::text, true;
        return;
      end if;
      return query select ex.id, ex.status, true;
      return;
    elsif ex.status = 'running' then
      raise exception 'QUEUE_DUPLICATE';
    end if;
    update publish_jobs set status = 'cancelled', cancel_reason = 'superseded', locked_at = null, locked_by = null,
      updated_at = now() where id = ex.id;
  end if;

  if (select count(*) from publish_jobs j where j.workspace_id = a.workspace_id and j.status = 'queued') >= 50 then
    raise exception 'QUEUE_FULL';
  end if;
  insert into publish_jobs (workspace_id, article_id, approved_version_id, remote_key, idempotency_key, created_by)
    values (a.workspace_id, a.id, vid, btrim(p_remote_key), a.workspace_id || ':' || a.id || ':' || vid, auth.uid())
    returning id into nid;
  return query select nid, 'queued'::text, false;
end $$;

-- ---------- claim ----------
-- Claims at most one job of p_remote_key from workspaces where the caller may publish. Returns no row when
-- nothing can run now. Reclaims stuck running jobs of those workspaces first. Reveals nothing about other tenants.
create function claim_publish_job(p_remote_key text)
returns table (job_id uuid, article_id uuid, approved_version_id uuid)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  uid uuid := auth.uid();
  wss uuid[];
  w uuid;
  j publish_jobs;
  r publish_jobs;
  a articles;
  latest uuid;
begin
  if uid is null then raise exception 'FORBIDDEN_ROLE'; end if;
  select coalesce(array_agg(m.workspace_id order by m.workspace_id), '{}') into wss
    from memberships m where m.user_id = uid and m.role in ('owner', 'admin', 'editor');
  if cardinality(wss) = 0 then raise exception 'FORBIDDEN_ROLE'; end if;
  if p_remote_key is null or length(btrim(p_remote_key)) not between 1 and 500 then
    raise exception 'REMOTE_KEY_INVALID';
  end if;
  -- Serializes claims of one site, then of each workspace (same order everywhere).
  perform pg_advisory_xact_lock(hashtextextended('publish_remote:' || p_remote_key, 20));
  foreach w in array wss loop
    perform pg_advisory_xact_lock(hashtextextended('publish_ws:' || w::text, 21));
  end loop;

  for r in select * from publish_jobs x where x.workspace_id = any (wss) and x.remote_key = p_remote_key
      and x.status = 'running' and x.locked_at < now() - interval '5 minutes' order by x.id for update loop
    update publish_jobs set status = case when r.attempts >= r.max_attempts then 'failed' else 'queued' end,
      next_attempt_at = now(), locked_at = null, locked_by = null, last_error = 'stale_reclaim', updated_at = now()
      where id = r.id;
    update articles set state = 'publish_failed' where id = r.article_id and state = 'publishing';
    insert into audit_logs (workspace_id, actor_id, action, payload)
      values (r.workspace_id, uid, 'publish.stale_reclaim', jsonb_build_object('job_id', r.id, 'article_id', r.article_id));
  end loop;

  -- One running job per site across all workspaces (only the fact is used, nothing is returned about it).
  -- A running job past the stale limit is not counted, even in another workspace (only its owner may change it):
  -- one attempt takes 45 seconds at worst, so after 5 minutes it has ended and a crashed holder must not block the site.
  if exists (select 1 from publish_jobs x where x.remote_key = p_remote_key and x.status = 'running'
      and x.locked_at >= now() - interval '5 minutes') then
    return;
  end if;

  for j in select * from publish_jobs x where x.status = 'queued' and x.next_attempt_at <= now()
      and x.remote_key = p_remote_key and x.workspace_id = any (wss)
      order by x.next_attempt_at, x.created_at for update skip locked loop
    if (select count(*) from publish_jobs x where x.workspace_id = j.workspace_id and x.status = 'running'
        and x.locked_at >= now() - interval '5 minutes') >= 3 then
      continue;
    end if;
    select * into a from articles where id = j.article_id for update;
    select v.id into latest from article_versions v where v.article_id = j.article_id order by v.version desc limit 1;
    if latest is distinct from j.approved_version_id then
      update publish_jobs set status = 'cancelled', cancel_reason = 'stale_version', updated_at = now() where id = j.id;
      continue;
    elsif a.state not in ('export_ready', 'publish_failed') then
      update publish_jobs set status = 'cancelled', cancel_reason = 'article_changed', updated_at = now() where id = j.id;
      continue;
    end if;
    update articles set state = 'publishing' where id = a.id;
    update publish_jobs set status = 'running', attempts = attempts + 1, locked_at = now(), locked_by = uid,
      updated_at = now() where id = j.id;
    return query select j.id, j.article_id, j.approved_version_id;
    return;
  end loop;
  return;
end $$;

-- ---------- finish ----------
-- Only the user who claimed a running job can finish it. outcome: success | retry | fail | attention.
-- Returns the new job status. A retry past max_attempts, or more than 1 hour away, does not stay queued.
create function finish_publish_job(p_job_id uuid, p_outcome text, p_retry_at timestamptz default null, p_error text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  j publish_jobs;
  st text;
  err text := left(p_error, 500);
begin
  if auth.uid() is null then raise exception 'FORBIDDEN_ROLE'; end if;
  if p_outcome is null or p_outcome not in ('success', 'retry', 'fail', 'attention') then
    raise exception 'OUTCOME_INVALID';
  end if;
  select * into j from publish_jobs where id = p_job_id and status = 'running' and locked_by = auth.uid() for update;
  if not found then raise exception 'JOB_NOT_RUNNING'; end if;
  if not is_member(j.workspace_id, array['owner','admin','editor']::workspace_role[]) then
    raise exception 'FORBIDDEN_ROLE';
  end if;

  if p_outcome = 'success' then
    st := 'draft_created'; err := null;
  elsif p_outcome = 'retry' then
    if j.attempts >= j.max_attempts then
      st := 'failed'; err := left('QUEUE_EXHAUSTED: ' || coalesce(err, ''), 500);
    elsif p_retry_at is not null and p_retry_at > now() + interval '1 hour' then
      st := 'needs_attention';
    else
      st := 'queued';
    end if;
  elsif p_outcome = 'fail' then
    st := 'failed';
  else
    st := 'needs_attention';
  end if;

  update publish_jobs set status = st, locked_at = null, locked_by = null, last_error = err,
    next_attempt_at = case when st = 'queued' then greatest(coalesce(p_retry_at, now()), now()) else next_attempt_at end,
    updated_at = now() where id = j.id;
  update articles set state = case when st = 'draft_created' then 'draft_created'::article_state
                                   else 'publish_failed'::article_state end
    where id = j.article_id and state = 'publishing';
  return st;
end $$;

-- ---------- cancel ----------
-- queued (and needs_attention, which would otherwise block the article) only. A running job ends with its attempt.
-- The article state is not touched: it is already export_ready or publish_failed.
create function cancel_publish_job(p_job_id uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
  j publish_jobs;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN_ROLE'; end if;
  select workspace_id into ws from publish_jobs where id = p_job_id;
  if not found or not is_member(ws, array['owner','admin','editor']::workspace_role[]) then
    raise exception 'FORBIDDEN_ROLE';
  end if;
  select * into j from publish_jobs where id = p_job_id for update;
  if j.status = 'running' then raise exception 'JOB_RUNNING'; end if;
  if j.status not in ('queued', 'needs_attention') then raise exception 'JOB_NOT_CANCELLABLE'; end if;
  update publish_jobs set status = 'cancelled', cancel_reason = 'user_cancel', updated_at = now() where id = j.id;
  return 'cancelled';
end $$;

revoke all on function enqueue_publish_job(uuid, text), claim_publish_job(text),
  finish_publish_job(uuid, text, timestamptz, text), cancel_publish_job(uuid) from public, anon;
grant execute on function enqueue_publish_job(uuid, text), claim_publish_job(text),
  finish_publish_job(uuid, text, timestamptz, text), cancel_publish_job(uuid) to authenticated;
