-- 0025: storage contract for API-synced rows (CF-07b, ANALYTICS_SYNC.md sections 2 and 5).
-- Synced rows live in the existing tables, apart from hand/CSV rows by their source / tool value:
--   revenue_rows.source = 'adsense-api' (source is free text, 0005 length check only: no schema change),
--   blog_metric_snapshots.tool = 'gsc-api' | 'ga4-api' (added to the tool check below).
-- Three new columns on both tables record where a row came from. Old rows keep the defaults.
-- The connection FK has no ON DELETE action on purpose: a connection with synced rows can not be
-- deleted (no orphans); disconnect_connection (0026) removes the rows first when asked to purge.
-- A client can not write these rows directly (guard triggers below): only replace_synced_range (0026) does.

alter table revenue_rows
  add column coverage text not null default 'complete' check (coverage in ('complete', 'partial')),
  add column sync_run_id uuid,
  add column connection_id uuid;
alter table revenue_rows
  add constraint revenue_rows_sync_run_fk foreign key (workspace_id, sync_run_id)
    references analytics_sync_runs (workspace_id, id) on delete set null (sync_run_id),
  add constraint revenue_rows_connection_fk foreign key (workspace_id, connection_id)
    references analytics_connections (workspace_id, id);
create index revenue_rows_connection_idx on revenue_rows (workspace_id, connection_id, report_date) where connection_id is not null;
comment on column revenue_rows.coverage is 'partial = the run did not cover the whole range; never counted as complete data.';

alter table blog_metric_snapshots
  add column coverage text not null default 'complete' check (coverage in ('complete', 'partial')),
  add column sync_run_id uuid,
  add column connection_id uuid;
alter table blog_metric_snapshots
  add constraint blog_metric_snapshots_sync_run_fk foreign key (workspace_id, sync_run_id)
    references analytics_sync_runs (workspace_id, id) on delete set null (sync_run_id),
  add constraint blog_metric_snapshots_connection_fk foreign key (workspace_id, connection_id)
    references analytics_connections (workspace_id, id);
create index blog_metric_snapshots_connection_idx on blog_metric_snapshots (workspace_id, connection_id, measured_on) where connection_id is not null;

-- Tool ids are mirrored in apps/web/src/lib/blog-metrics.ts (METRIC_TOOLS = the 0017 list, SYNCED_METRIC_TOOLS = the two new ones).
alter table blog_metric_snapshots drop constraint blog_metric_snapshots_tool_check;
alter table blog_metric_snapshots add constraint blog_metric_snapshots_tool_check
  check (tool in ('bseupi', 'blackkiwi', 'blogai', 'gsc', 'ubersuggest', 'clarity', 'other', 'gsc-api', 'ga4-api'));

comment on table blog_metric_snapshots is 'Per-tool values per blog with tool, date and evidence: typed by hand, imported from a CSV, or (tool gsc-api / ga4-api) synced through replace_synced_range from Google with the connection and run recorded. Never combined across tools, no self-made index.';
comment on column blog_metric_snapshots.tool is 'gsc-api and ga4-api rows come only from replace_synced_range; other values are what the operator typed or imported.';
comment on table revenue_rows is 'Revenue report rows: imported CSV/hand rows, or source adsense-api rows written only by replace_synced_range. Different sources are never merged.';

-- Not security definer: current_user is the statement's role (authenticated for a client, the function
-- owner inside the definer RPCs). A client can not forge a synced row or provenance.
create function guard_synced_revenue_row() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('authenticated', 'anon')
     and (lower(btrim(new.source)) = 'adsense-api' or new.connection_id is not null
          or new.sync_run_id is not null or new.coverage <> 'complete') then
    raise exception 'SYNCED_ROW_FORBIDDEN';
  end if;
  return new;
end $$;
create trigger revenue_rows_synced_guard before insert or update on revenue_rows
  for each row execute function guard_synced_revenue_row();

create function guard_synced_metric_row() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('authenticated', 'anon')
     and (new.tool in ('gsc-api', 'ga4-api') or new.connection_id is not null
          or new.sync_run_id is not null or new.coverage <> 'complete') then
    raise exception 'SYNCED_ROW_FORBIDDEN';
  end if;
  return new;
end $$;
create trigger blog_metric_snapshots_synced_guard before insert or update on blog_metric_snapshots
  for each row execute function guard_synced_metric_row();
