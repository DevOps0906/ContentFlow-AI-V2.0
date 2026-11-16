-- 0021: publish queue — serialize a site per workspace, not across tenants (CF-24, docs/06-workflows/PUBLISH_QUEUE.md §18).
-- Across tenants any user with publish rights could call claim_publish_job directly (PostgREST) and hold a shared
-- remote_key without finishing, blocking every other tenant; remote_key is also chosen by the caller at enqueue.
-- Only claim_publish_job changes; signature, return type, grants and every other rule of 0020 stay.
-- Replaces the 0020 index comment ("one running job per remote site across all workspaces ... advisory lock per
-- remote_key"): it is now one running job per (workspace, remote_key), under the per-workspace advisory lock.

drop index if exists publish_jobs_remote_running_idx;
create index publish_jobs_ws_remote_running_idx on publish_jobs (workspace_id, remote_key) where status = 'running';

create or replace function claim_publish_job(p_remote_key text)
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
  -- Serializes claims of each workspace (same order everywhere).
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

  for j in select * from publish_jobs x where x.status = 'queued' and x.next_attempt_at <= now()
      and x.remote_key = p_remote_key and x.workspace_id = any (wss)
      order by x.next_attempt_at, x.created_at for update skip locked loop
    -- One running job per site inside one workspace (0021: no longer across workspaces, so one tenant can not
    -- hold a site other tenants send to, and nothing about other tenants is used at all).
    if exists (select 1 from publish_jobs x where x.workspace_id = j.workspace_id and x.remote_key = p_remote_key
        and x.status = 'running' and x.locked_at >= now() - interval '5 minutes') then
      continue;
    end if;
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
