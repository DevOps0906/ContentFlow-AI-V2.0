-- 0026: replace_synced_range, purge, disconnect and reconnect (CF-07b, ANALYTICS_SYNC.md sections 3, 4, D4).
-- replace_synced_range is one transaction. A complete run deletes the previous API rows of THIS
-- connection inside its date range and cuts the period of earlier rows to the day before the range. A
-- partial run replaces only the days it brings (everything else stays, with its period narrowed to its own
-- day, so no stored row claims days a partial run did not cover). Nothing else is touched: hand and CSV
-- rows (other source / tool, no connection_id) and other connections' rows are never targets.
-- Security definer bypasses RLS, so owner/admin of the connection's workspace and created_by =
-- auth.uid() are checked here; the caller is still a "client" for 0019 / the row caps
-- (no set_config('role') / SET ROLE here).

-- Same rule as rowKey / normalizePage in apps/web/src/lib/revenue.ts (an http(s) URL: host + path
-- without trailing slashes, lower case, the query only for a root path; anything else: text before ? or #).
-- Known difference: no default-port or percent-encoding normalization of the WHATWG URL parser.
create function cf_normalize_page(page text) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare p text := btrim(page); m text[]; path text; res text;
begin
  if p = '' then return ''; end if;
  m := regexp_match(p, '^https?://(?:[^/?#@]*@)?([^/?#]*)([^?#]*)(\?[^#]*)?', 'i');
  if m is not null then
    path := case when m[2] = '' then '/' else m[2] end;
    res := lower(regexp_replace(m[1] || path, '/+$', ''));
    if path = '/' and m[3] is not null and m[3] <> '?' then res := res || m[3]; end if;
    return res;
  end if;
  res := lower(regexp_replace((regexp_split_to_array(p, '[?#]'))[1], '/+$', ''));
  return case when res = '' then '/' else res end;
end $$;

create function cf_revenue_row_key(source text, status text, currency text, report_date date, page text, timezone text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select concat_ws('|', lower(source), status, currency, report_date::text, cf_normalize_page(page), nullif(timezone, ''))
$$;
revoke all on function cf_normalize_page(text), cf_revenue_row_key(text, text, text, date, text, text) from public, anon, authenticated;

-- p_rows (jsonb array):
--   adsense: {report_date, status, currency, page, timezone, revenue, pageviews, impressions, clicks}
--   gsc/ga4: {metric, scope, dimension, value, unit, measured_on}   (blog_id comes from the connection)
-- p_coverage 'partial' = the run did not cover the range; the run is recorded as partial.
-- Returns the number of rows written. An empty complete array is a successful run with no data.
-- Errors: SYNC_RUN_INVALID, SYNC_ROWS_INVALID, SYNC_ROWS_DUPLICATE (a measurement twice in p_rows),
-- SYNC_CAP_EXCEEDED (the workspace row cap would be passed; nothing is written), SYNC_RANGE_BEHIND.
create function replace_synced_range(p_connection uuid, p_run uuid, p_range_start date, p_range_end date, p_rows jsonb, p_coverage text default 'complete')
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  con analytics_connections;
  r analytics_sync_runs;
  n int;
  t text;
  partial boolean;
begin
  select * into con from analytics_connections where id = p_connection for update;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform cf_analytics_require_admin(con.workspace_id);
  if con.status not in ('pending', 'active', 'error') then raise exception 'CONNECTION_NOT_ACTIVE'; end if;
  select * into r from analytics_sync_runs where id = p_run and connection_id = con.id for update;
  if not found or r.status <> 'running' or r.requested_by <> auth.uid()
     or r.range_start is distinct from p_range_start or r.range_end is distinct from p_range_end then
    raise exception 'SYNC_RUN_INVALID';
  end if;
  if p_coverage is null or p_coverage not in ('complete', 'partial')
     or p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 50000 then
    raise exception 'SYNC_ROWS_INVALID';
  end if;
  partial := p_coverage = 'partial';

  if con.provider = 'adsense' then
    t := 'adsense-api';
    if exists (select 1 from jsonb_to_recordset(p_rows) x(report_date date)
               where x.report_date is null or x.report_date not between p_range_start and p_range_end) then
      raise exception 'SYNC_ROWS_INVALID';
    end if;
    if exists (select 1 from jsonb_to_recordset(p_rows) as x(report_date date, status text, currency text, page text, timezone text)
               group by cf_revenue_row_key(t, x.status, x.currency, x.report_date, coalesce(x.page, ''), x.timezone)
               having count(*) > 1) then
      raise exception 'SYNC_ROWS_DUPLICATE';
    end if;
    -- A later row of this connection would overlap the new period: refuse instead of cutting it.
    if exists (select 1 from revenue_rows where workspace_id = con.workspace_id and connection_id = con.id
               and source = t and report_date > p_range_end) then
      raise exception 'SYNC_RANGE_BEHIND';
    end if;
    if partial then
      delete from revenue_rows
        where workspace_id = con.workspace_id and connection_id = con.id and source = t
          and report_date in (select x.report_date from jsonb_to_recordset(p_rows) x(report_date date));
      -- Old rows that still cover days of this range keep only their own day.
      update revenue_rows set period_start = report_date, period_end = report_date
        where workspace_id = con.workspace_id and connection_id = con.id and source = t and period_end >= p_range_start;
    else
      delete from revenue_rows
        where workspace_id = con.workspace_id and connection_id = con.id and source = t
          and report_date between p_range_start and p_range_end;
      -- Remaining rows of this connection are all before the range: their period stops the day before it.
      update revenue_rows set period_end = p_range_start - 1
        where workspace_id = con.workspace_id and connection_id = con.id and source = t and period_end >= p_range_start;
    end if;
    if (select count(*) from revenue_rows where workspace_id = con.workspace_id) + jsonb_array_length(p_rows) > 20000 then
      raise exception 'SYNC_CAP_EXCEEDED';
    end if;
    insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, page, revenue,
                              pageviews, impressions, clicks, created_by, timezone, period_start, period_end,
                              coverage, sync_run_id, connection_id)
      select con.workspace_id, cf_revenue_row_key(t, x.status, x.currency, x.report_date, coalesce(x.page, ''), x.timezone),
             t, x.status, x.currency, x.report_date, coalesce(x.page, ''), x.revenue,
             x.pageviews, x.impressions, x.clicks, auth.uid(), x.timezone,
             case when partial then x.report_date else p_range_start end,
             case when partial then x.report_date else p_range_end end,
             p_coverage, r.id, con.id
      from jsonb_to_recordset(p_rows) as x(report_date date, status text, currency text, page text, timezone text,
                                           revenue numeric, pageviews bigint, impressions bigint, clicks bigint);
  elsif con.provider in ('gsc', 'ga4') then
    t := con.provider || '-api';
    if exists (select 1 from jsonb_to_recordset(p_rows) x(measured_on date)
               where x.measured_on is null or x.measured_on not between p_range_start and p_range_end) then
      raise exception 'SYNC_ROWS_INVALID';
    end if;
    -- Same measurement key as the 0017 unique constraint (metric_key, scope, dimension_key, day).
    if exists (select 1 from jsonb_to_recordset(p_rows) as x(metric text, scope text, dimension text, measured_on date)
               group by lower(regexp_replace(btrim(normalize(x.metric, NFKC)), '\s+', ' ', 'g')), coalesce(x.scope, 'page'),
                        md5(case when coalesce(x.scope, 'page') = 'query'
                                 then lower(regexp_replace(btrim(normalize(coalesce(x.dimension, ''), NFKC)), '\s+', ' ', 'g'))
                                 else btrim(coalesce(x.dimension, '')) end),
                        x.measured_on
               having count(*) > 1) then
      raise exception 'SYNC_ROWS_DUPLICATE';
    end if;
    if partial then
      delete from blog_metric_snapshots
        where workspace_id = con.workspace_id and connection_id = con.id and tool = t
          and measured_on in (select x.measured_on from jsonb_to_recordset(p_rows) x(measured_on date));
    else
      delete from blog_metric_snapshots
        where workspace_id = con.workspace_id and connection_id = con.id and tool = t
          and measured_on between p_range_start and p_range_end;
    end if;
    if (select count(*) from blog_metric_snapshots where workspace_id = con.workspace_id) + jsonb_array_length(p_rows) > 30000 then
      raise exception 'SYNC_CAP_EXCEEDED';
    end if;
    insert into blog_metric_snapshots (workspace_id, blog_id, tool, metric, scope, dimension, value, unit,
                                       measured_on, created_by, coverage, sync_run_id, connection_id)
      select con.workspace_id, con.blog_id, t, x.metric, coalesce(x.scope, 'page'), coalesce(x.dimension, ''),
             x.value, coalesce(x.unit, ''), x.measured_on, auth.uid(), p_coverage, r.id, con.id
      from jsonb_to_recordset(p_rows) as x(metric text, scope text, dimension text, value numeric, unit text, measured_on date);
  else
    raise exception 'SYNC_ROWS_INVALID';
  end if;
  get diagnostics n = row_count;

  update analytics_sync_runs
    set status = case when partial then 'partial' else 'succeeded' end,
        rows_written = n, error_code = null, finished_at = now()
    where id = r.id;
  update analytics_connections
    set status = 'active', last_attempt_at = now(), last_success_at = now(), last_error_code = null
    where id = con.id;
  insert into audit_logs (workspace_id, actor_id, action, payload)
    values (con.workspace_id, auth.uid(), 'analytics.sync',
            jsonb_build_object('run_id', r.id, 'connection_id', con.id, 'provider', con.provider,
                               'rows', n, 'coverage', p_coverage));
  return n;
end $$;

-- Deletes only this connection's synced rows (revenue_rows source adsense-api, metric tools gsc-api / ga4-api).
create function cf_delete_synced_rows(con analytics_connections) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare a int := 0; b int := 0;
begin
  delete from revenue_rows where workspace_id = con.workspace_id and connection_id = con.id and source = 'adsense-api';
  get diagnostics a = row_count;
  delete from blog_metric_snapshots where workspace_id = con.workspace_id and connection_id = con.id and tool in ('gsc-api', 'ga4-api');
  get diagnostics b = row_count;
  return a + b;
end $$;
revoke all on function cf_delete_synced_rows(analytics_connections) from public, anon, authenticated;

-- Deletes the synced rows of a connection and keeps the connection. Returns the count.
create function purge_synced_rows(p_connection uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare con analytics_connections; n int;
begin
  select * into con from analytics_connections where id = p_connection for update;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform cf_analytics_require_admin(con.workspace_id);
  n := cf_delete_synced_rows(con);
  insert into audit_logs (workspace_id, actor_id, action, payload)
    values (con.workspace_id, auth.uid(), 'analytics.purge',
            jsonb_build_object('connection_id', con.id, 'provider', con.provider, 'rows', n));
  return n;
end $$;

-- Ends a connection (the only way: no client DELETE policy). Keep (p_purge false, D4 default): the row
-- stays as 'revoked' with its grant released, so the imported rows keep their connection. Purge: the
-- synced rows and the connection are deleted. Returns how many connections of the workspace still use
-- the grant: 0 means the app now revokes the token at Google and calls delete_credential.
create function disconnect_connection(p_connection uuid, p_purge boolean default false) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare con analytics_connections; n int := 0; left_over int;
begin
  select * into con from analytics_connections where id = p_connection for update;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform cf_analytics_require_admin(con.workspace_id);
  if p_purge then
    n := cf_delete_synced_rows(con);
    delete from analytics_connections where id = con.id;
  else
    update analytics_connections set status = 'revoked', grant_id = null, last_error_code = null where id = con.id;
  end if;
  insert into audit_logs (workspace_id, actor_id, action, payload)
    values (con.workspace_id, auth.uid(), 'analytics.disconnect',
            jsonb_build_object('connection_id', con.id, 'provider', con.provider, 'purged', coalesce(p_purge, false), 'rows', n));
  select count(*) into left_over from analytics_connections
    where workspace_id = con.workspace_id and grant_id is not null and grant_id = con.grant_id and id <> con.id;
  return left_over;
end $$;

-- Takes a revoked connection back with a grant (same property again, after a new consent). The kept rows
-- stay attached; it turns active on the next successful sync.
create function reconnect_connection(p_connection uuid, p_grant uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare con analytics_connections;
begin
  select * into con from analytics_connections where id = p_connection for update;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform cf_analytics_require_admin(con.workspace_id);
  if con.status <> 'revoked' then raise exception 'CONNECTION_NOT_REVOKED'; end if;
  if p_grant is null or not cf_grant_creator_active(con.workspace_id, p_grant) then raise exception 'GRANT_OWNER_INACTIVE'; end if;
  update analytics_connections set grant_id = p_grant, status = 'pending', connected_by = auth.uid(), last_error_code = null
    where id = con.id;
  insert into audit_logs (workspace_id, actor_id, action, payload)
    values (con.workspace_id, auth.uid(), 'analytics.reconnect', jsonb_build_object('connection_id', con.id, 'provider', con.provider));
end $$;

revoke all on function replace_synced_range(uuid, uuid, date, date, jsonb, text), purge_synced_rows(uuid),
  disconnect_connection(uuid, boolean), reconnect_connection(uuid, uuid) from public, anon, authenticated;
grant execute on function replace_synced_range(uuid, uuid, date, date, jsonb, text), purge_synced_rows(uuid),
  disconnect_connection(uuid, boolean), reconnect_connection(uuid, uuid) to authenticated;
