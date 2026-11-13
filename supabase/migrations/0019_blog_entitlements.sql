-- 0019: blog entitlements and limits (CF-22, docs/01-planning/MULTI_BLOG_BILLING.md section 13).
-- workspace_entitlements is the source of truth for how many blogs a workspace may have. Clients can
-- only read it; a plan change is made by a system role (service role, SQL), never by authenticated/anon.
-- Limits are enforced by triggers on blogs. Plan numbers are hypotheses (section 3): change them here.
--
-- "Client" = the session role is authenticated or anon. These trigger functions are security definer,
-- where current_user is the function owner, so the caller is read from the session GUC `role` (set by
-- SET ROLE, which PostgREST and the tests use). A system role (postgres, service_role) is exempt from
-- the limit checks, but its changes are still metered.

-- Fail closed: only an explicit system role is exempt, everything else is a client.
-- Never call set_config('role', ...) or SET ROLE in a new RPC or function: that would change this answer.
create function cf_caller_is_client() returns boolean
language sql stable set search_path = public as $$
  select case
    when coalesce(current_setting('role', true), '') in ('service_role', 'postgres', 'supabase_admin') then false
    when coalesce(current_setting('role', true), '') in ('none', '') and session_user in ('postgres', 'supabase_admin') then false
    else true
  end
$$;
revoke all on function cf_caller_is_client() from public, anon, authenticated;

-- There is no payment yet, so no plan other than free/basic/pro can be justified: correct any other value to free.
-- (Runs before the plan lock trigger below exists.)
update workspaces set plan = 'free' where plan not in ('free', 'basic', 'pro');

-- Plan defaults. Keep in sync with the plan table in the planning doc.
create function plan_defaults(p text)
returns table (included_blogs int, max_blogs int, overage_allowed boolean)
language plpgsql immutable set search_path = public as $$
begin
  if p = 'free' then return query select 1, 1, false;
  elsif p = 'basic' then return query select 3, 10, true;
  elsif p = 'pro' then return query select 10, 30, true;
  else raise exception 'PLAN_UNKNOWN';
  end if;
end $$;
revoke all on function plan_defaults(text) from public, anon, authenticated;

create table workspace_entitlements (
  workspace_id uuid primary key references workspaces (id) on delete cascade,
  plan text not null,
  included_blogs int not null check (included_blogs >= 1),
  max_blogs int not null,
  overage_allowed boolean not null,
  grace_until timestamptz,
  grace_active_cap int check (grace_active_cap is null or grace_active_cap >= 0),
  updated_at timestamptz not null default now(),
  check (max_blogs >= included_blogs)
);
comment on table workspace_entitlements is 'Blog limits per workspace. Members read, only system roles write (plan sync trigger or operator SQL).';
comment on column workspace_entitlements.grace_until is 'Until this time a workspace that already had more active blogs than included keeps up to grace_active_cap, without confirmation. Extended by operator SQL.';

create table blog_usage_snapshots (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  period_start date not null,
  period_end date not null,
  peak_active int not null,
  active_at_close int not null,
  overage_slots int not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, period_start)
);
comment on table blog_usage_snapshots is 'Monthly (Asia/Seoul calendar month) peak of active blogs. period_end is the first day of the next month (exclusive). No amounts: billing is CF-23.';

alter table workspace_entitlements enable row level security;
alter table blog_usage_snapshots enable row level security;
create policy entitlements_select on workspace_entitlements for select to authenticated using (is_member(workspace_id));
create policy usage_snapshots_select on blog_usage_snapshots for select to authenticated using (is_member(workspace_id));
-- No write policies, and no write privileges either (Supabase grants them by default).
revoke all on workspace_entitlements, blog_usage_snapshots from anon, authenticated;
grant select on workspace_entitlements, blog_usage_snapshots to authenticated;

-- Existing workspaces. A workspace that already has more active blogs than its plan includes gets a
-- 90 day grace with the active count frozen as the cap (no blocking, only the cap).
insert into workspace_entitlements (workspace_id, plan, included_blogs, max_blogs, overage_allowed)
  select w.id, w.plan, d.included_blogs, d.max_blogs, d.overage_allowed
  from workspaces w cross join lateral plan_defaults(w.plan) d;
update workspace_entitlements e
  set grace_until = now() + interval '90 days', grace_active_cap = c.n
  from (select workspace_id, count(*)::int n from blogs where status = 'active' group by workspace_id) c
  where c.workspace_id = e.workspace_id and c.n > e.included_blogs;

-- ---------- workspaces.plan lock and sync ----------
create function enforce_plan_lock() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if cf_caller_is_client()
     and ((tg_op = 'INSERT' and new.plan <> 'free')
          or (tg_op = 'UPDATE' and new.plan is distinct from old.plan)) then
    raise exception 'PLAN_CHANGE_FORBIDDEN';
  end if;
  return new;
end $$;
create trigger workspaces_plan_lock before insert or update of plan on workspaces
  for each row execute function enforce_plan_lock();

-- Every workspace has an entitlements row; a plan change by a system role resets it to the plan defaults.
create function sync_workspace_entitlements() returns trigger
language plpgsql security definer set search_path = public as $$
declare d record;
begin
  if tg_op = 'UPDATE' and new.plan = old.plan then return null; end if;
  select * into d from plan_defaults(new.plan);
  insert into workspace_entitlements (workspace_id, plan, included_blogs, max_blogs, overage_allowed)
    values (new.id, new.plan, d.included_blogs, d.max_blogs, d.overage_allowed)
    on conflict (workspace_id) do update
      set plan = excluded.plan, included_blogs = excluded.included_blogs,
          max_blogs = excluded.max_blogs, overage_allowed = excluded.overage_allowed, updated_at = now();
  return null;
end $$;
create trigger workspaces_entitlements_sync after insert or update of plan on workspaces
  for each row execute function sync_workspace_entitlements();

-- ---------- blogs: limits and overage confirmation ----------
-- The confirmation signal is a column in the same statement. It is never stored: the trigger writes
-- the audit row itself and resets the column to false.
alter table blogs add column overage_ack boolean not null default false;
comment on column blogs.overage_ack is 'Write-only signal: true in the same insert/update confirms an extra-fee blog. Always stored as false; the confirmation is recorded in audit_logs (blog.overage_ack).';
comment on column blogs.status is 'active or archived. An archived account stays linked to its articles and keywords and can not be linked to new ones. It can be restored to active, which goes through the same limit check as a new blog.';

create function enforce_blog_limits() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  client boolean := cf_caller_is_client();
  ack boolean := coalesce(new.overage_ack, false);
  ent workspace_entitlements;
  before_n int;
  next_n int;
begin
  new.overage_ack := false;
  if tg_op = 'UPDATE' and client and new.workspace_id is distinct from old.workspace_id then
    raise exception 'BLOG_WORKSPACE_IMMUTABLE';
  end if;
  -- Only a row that becomes active is checked: a new active row, or archived -> active.
  if not (new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active')) then
    return new;
  end if;
  -- Serializes concurrent activations of one workspace until commit.
  perform 1 from workspaces where id = new.workspace_id for update;
  if not client then return new; end if;
  select * into ent from workspace_entitlements where workspace_id = new.workspace_id;
  if not found then raise exception 'ENTITLEMENT_MISSING'; end if;
  select count(*) into before_n from blogs
    where workspace_id = new.workspace_id and status = 'active' and id <> new.id;
  next_n := before_n + 1;

  if ent.grace_until is not null and ent.grace_until > now() then
    -- Only up to the frozen count is exempt; anything above goes through the normal rules below.
    if next_n <= coalesce(ent.grace_active_cap, 0) then
      return new;
    end if;
  end if;
  if not ent.overage_allowed and next_n > ent.included_blogs then raise exception 'PLAN_NOT_ALLOWED'; end if;
  if next_n > ent.max_blogs then raise exception 'BLOG_LIMIT_REACHED'; end if;
  if next_n > ent.included_blogs then
    if not is_member(new.workspace_id, array['owner']::workspace_role[]) then
      raise exception 'FORBIDDEN_ROLE';
    end if;
    if not ack then raise exception 'BLOG_LIMIT_CONFIRM_REQUIRED'; end if;
    insert into audit_logs (workspace_id, actor_id, action, payload)
      values (new.workspace_id, auth.uid(), 'blog.overage_ack', jsonb_build_object(
        'active_before', before_n, 'active_after', next_n,
        'included', ent.included_blogs, 'notice_version', 'v1'));
  end if;
  return new;
end $$;
create trigger blogs_limits before insert or update on blogs
  for each row execute function enforce_blog_limits();

-- ---------- peak metering ----------
create function meter_blog_workspace(ws uuid, was_active boolean, is_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  ent workspace_entitlements;
  cur int;
  prior int;
  peak int;
  ps date := date_trunc('month', now() at time zone 'Asia/Seoul')::date;
begin
  -- A workspace that is being deleted has nothing left to meter.
  if not exists (select 1 from workspaces where id = ws) then return; end if;
  select * into ent from workspace_entitlements where workspace_id = ws;
  if not found then return; end if;
  select count(*) into cur from blogs where workspace_id = ws and status = 'active';
  -- Count before this change: a month's first event may be an archive, which must not hide the peak.
  prior := cur + case when was_active then 1 else 0 end - case when is_active then 1 else 0 end;
  peak := greatest(cur, prior);
  insert into blog_usage_snapshots as s (workspace_id, period_start, period_end, peak_active, active_at_close, overage_slots)
    values (ws, ps, (ps + interval '1 month')::date, peak, cur, greatest(0, peak - ent.included_blogs))
    on conflict (workspace_id, period_start) do update set
      peak_active = greatest(s.peak_active, excluded.peak_active),
      active_at_close = excluded.active_at_close,
      overage_slots = greatest(0, greatest(s.peak_active, excluded.peak_active) - ent.included_blogs);
end $$;
revoke all on function meter_blog_workspace(uuid, boolean, boolean) from public, anon, authenticated;

create function meter_blog_usage() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.status = new.status and old.workspace_id = new.workspace_id then
    return null;
  end if;
  if tg_op <> 'INSERT' then
    perform meter_blog_workspace(old.workspace_id, old.status = 'active',
      tg_op = 'UPDATE' and new.workspace_id = old.workspace_id and new.status = 'active');
  end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.workspace_id <> old.workspace_id) then
    perform meter_blog_workspace(new.workspace_id, false, new.status = 'active');
  end if;
  return null;
end $$;
create trigger blogs_usage after insert or update or delete on blogs
  for each row execute function meter_blog_usage();

-- ---------- audit_logs: blog.* rows are written by the triggers only ----------
-- The definer triggers (owner bypasses RLS) still insert them; a client can not forge a confirmation.
drop policy audit_insert on audit_logs;
create policy audit_insert on audit_logs for insert to authenticated
  with check (is_member(workspace_id) and actor_id = auth.uid() and action not like 'blog.%');
