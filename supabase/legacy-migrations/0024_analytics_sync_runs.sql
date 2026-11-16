-- 0024: sync run log (ANALYTICS_SYNC.md sections 4 and 5). Every attempt is recorded: status, requested
-- range, row count and an error code (no token, no response body). Members read; the rows are written
-- only by the RPCs below and by replace_synced_range (0026).

create table analytics_sync_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null,
  workspace_id uuid not null references workspaces (id) on delete cascade,
  requested_by uuid not null references auth.users (id),
  range_start date not null,
  range_end date not null,
  requested_at timestamptz not null default now(),
  status text not null default 'running' check (status in ('running', 'succeeded', 'partial', 'failed', 'delayed')),
  rows_written int not null default 0 check (rows_written >= 0),
  error_code text check (error_code is null or length(error_code) <= 60),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  check (range_start <= range_end),
  unique (workspace_id, id),
  foreign key (workspace_id, connection_id) references analytics_connections (workspace_id, id) on delete cascade
);
comment on table analytics_sync_runs is 'One row per sync attempt (status, requested range, rows, error code). Written by RPCs only, kept 90 days / 50 per connection.';
create index analytics_sync_runs_conn_idx on analytics_sync_runs (connection_id, requested_at desc);
create index analytics_sync_runs_ws_idx on analytics_sync_runs (workspace_id, requested_at desc);
-- One running sync per connection.
create unique index analytics_sync_runs_one_running on analytics_sync_runs (connection_id) where status = 'running';

alter table analytics_sync_runs enable row level security;
create policy analytics_sync_runs_select on analytics_sync_runs for select to authenticated using (is_member(workspace_id));
revoke all on analytics_sync_runs from anon, authenticated;
grant select on analytics_sync_runs to authenticated;

-- Retention: finished runs older than 90 days, or beyond the newest 50 of a connection.
create function trim_analytics_sync_runs() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from analytics_sync_runs
    where connection_id = new.connection_id and status <> 'running'
      and (requested_at < now() - interval '90 days'
           or id not in (select id from analytics_sync_runs where connection_id = new.connection_id
                         order by requested_at desc, id limit 50));
  return null;
end $$;
create trigger analytics_sync_runs_trim after insert on analytics_sync_runs
  for each row execute function trim_analytics_sync_runs();

-- Starts a run for the session user. Constants (ANALYTICS_SYNC.md D3): 15 minutes between runs of a
-- connection, a run still "running" after 10 minutes is closed as failed (STALE) before the cooldown
-- is judged (and is not counted in it).
create function begin_sync_run(p_connection uuid, p_range_start date, p_range_end date) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare con analytics_connections; r uuid;
begin
  select * into con from analytics_connections where id = p_connection for update;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform cf_analytics_require_admin(con.workspace_id);
  if con.status not in ('pending', 'active', 'error') then raise exception 'CONNECTION_NOT_ACTIVE'; end if;
  if not cf_grant_creator_active(con.workspace_id, con.grant_id) then raise exception 'GRANT_OWNER_INACTIVE'; end if;
  if p_range_start is null or p_range_end is null or p_range_start > p_range_end
     or p_range_end - p_range_start > 400 then
    raise exception 'SYNC_RANGE_INVALID';
  end if;
  update analytics_sync_runs set status = 'failed', error_code = 'STALE', finished_at = now()
    where connection_id = con.id and status = 'running' and started_at < now() - interval '10 minutes';
  if exists (select 1 from analytics_sync_runs where connection_id = con.id and status = 'running') then
    raise exception 'SYNC_RUNNING';
  end if;
  -- A run closed as STALE did not complete anything: it does not start a cooldown.
  if exists (select 1 from analytics_sync_runs where connection_id = con.id and requested_at > now() - interval '15 minutes'
             and not (status = 'failed' and error_code = 'STALE')) then
    raise exception 'SYNC_COOLDOWN';
  end if;
  insert into analytics_sync_runs (connection_id, workspace_id, requested_by, range_start, range_end)
    values (con.id, con.workspace_id, auth.uid(), p_range_start, p_range_end) returning id into r;
  update analytics_connections set last_attempt_at = now() where id = con.id;
  return r;
end $$;

-- Closes a run that did not write anything (failed / delayed). A failure never makes a connection
-- active and never creates rows. p_connection_status may move the connection to needs_reauth
-- (invalid_grant) or error (repeated failures).
create function finish_sync_run(p_run uuid, p_status text, p_error_code text, p_connection_status text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r analytics_sync_runs;
begin
  select * into r from analytics_sync_runs where id = p_run for update;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform cf_analytics_require_admin(r.workspace_id);
  if p_status not in ('failed', 'delayed')
     or (p_connection_status is not null and p_connection_status not in ('needs_reauth', 'error')) then
    raise exception 'SYNC_STATUS_INVALID';
  end if;
  if r.status <> 'running' or r.requested_by <> auth.uid() then raise exception 'SYNC_RUN_INVALID'; end if;
  update analytics_sync_runs set status = p_status, error_code = left(p_error_code, 60), finished_at = now() where id = r.id;
  update analytics_connections set last_attempt_at = now(), last_error_code = left(p_error_code, 60),
      status = coalesce(p_connection_status, status)
    where id = r.connection_id and status <> 'revoked';
  insert into audit_logs (workspace_id, actor_id, action, payload)
    values (r.workspace_id, auth.uid(), 'analytics.sync_failed',
            jsonb_build_object('run_id', r.id, 'status', p_status, 'error_code', left(p_error_code, 60)));
end $$;

revoke all on function begin_sync_run(uuid, date, date), finish_sync_run(uuid, text, text, text) from public, anon, authenticated;
grant execute on function begin_sync_run(uuid, date, date), finish_sync_run(uuid, text, text, text) to authenticated;
