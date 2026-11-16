-- 0017: per-tool performance records of a blog account (W11). Every value is what an external tool
-- showed the operator, typed by hand or imported from a Search Console CSV; nothing is fetched and
-- nothing is computed here. A blog index is the label or number a third-party tool displays, not an
-- official Naver metric. Values of different tools are never added or converted. No update policy:
-- a wrong row is deleted and entered again.

create table blog_metric_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  -- NULL means unclassified.
  blog_id uuid,
  -- Limits and tool ids are mirrored in apps/web/src/lib/blog-metrics.ts (a test compares them).
  tool text not null check (tool in ('bseupi', 'blackkiwi', 'blogai', 'gsc', 'ubersuggest', 'clarity', 'other')),
  metric text not null check (length(btrim(metric)) between 1 and 40),
  -- Same normalization as normalizePhrase in keywords.ts.
  metric_key text generated always as (
    lower(regexp_replace(btrim(normalize(metric, NFKC)), '\s+', ' ', 'g'))
  ) stored,
  -- site: the whole blog. query / page: one row of a Search Console export.
  scope text not null default 'site' check (scope in ('site', 'query', 'page')),
  dimension text not null default '' check (length(dimension) <= 2000),
  -- A query is compared like a keyword, a page address exactly. Hashed so a long URL fits the index.
  dimension_key text generated always as (
    md5(case when scope = 'query'
      then lower(regexp_replace(btrim(normalize(dimension, NFKC)), '\s+', ' ', 'g'))
      else btrim(dimension) end)
  ) stored,
  -- Exactly one of a number or a label (grades such as a tool's index level are labels).
  value numeric(20, 4) check (value between -1000000000000 and 1000000000000),
  value_label text check (value_label is null or length(btrim(value_label)) between 1 and 40),
  unit text not null default '' check (length(unit) <= 20),
  measured_on date not null check (measured_on between date '2000-01-01' and date '2100-01-01'),
  evidence_url text check (evidence_url is null or (evidence_url ~ '^https?://' and length(evidence_url) <= 2000)),
  memo text not null default '' check (length(memo) <= 500),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  constraint blog_metric_snapshots_one_value check (num_nonnulls(value, value_label) = 1),
  constraint blog_metric_snapshots_scope_dimension check ((scope = 'site') = (btrim(dimension) = '')),
  -- Composite FK keeps the link inside one workspace, and a blog that is still linked can not be deleted.
  constraint blog_metric_snapshots_blog_fk foreign key (workspace_id, blog_id) references blogs (workspace_id, id),
  -- NULLS NOT DISTINCT: importing the same unclassified rows again must be a duplicate too.
  constraint blog_metric_snapshots_measurement_key
    unique nulls not distinct (workspace_id, blog_id, tool, metric_key, scope, dimension_key, measured_on)
);
comment on table blog_metric_snapshots is 'Operator-supplied values of external tools per blog, with tool, date and evidence. Never fetched, never combined across tools, no self-made index.';
create index blog_metric_snapshots_ws_measured_idx on blog_metric_snapshots (workspace_id, measured_on desc);

-- Hard cap per workspace, enforced even if a client bypasses the API.
create function enforce_blog_metric_cap() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from blog_metric_snapshots where workspace_id = new.workspace_id) >= 30000 then
    raise exception 'blog metric limit reached (30000 per workspace)';
  end if;
  return new;
end $$;
create trigger blog_metric_snapshots_cap before insert on blog_metric_snapshots
  for each row execute function enforce_blog_metric_cap();

alter table blog_metric_snapshots enable row level security;
create policy blog_metric_snapshots_select on blog_metric_snapshots for select to authenticated using (is_member(workspace_id));
create policy blog_metric_snapshots_insert on blog_metric_snapshots for insert to authenticated
  with check (is_member(workspace_id, array['owner','admin','editor']::workspace_role[]) and created_by = auth.uid());
create policy blog_metric_snapshots_delete on blog_metric_snapshots for delete to authenticated
  using (is_member(workspace_id, array['owner','admin','editor']::workspace_role[]));
