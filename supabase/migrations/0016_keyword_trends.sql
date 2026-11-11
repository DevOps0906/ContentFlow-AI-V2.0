-- 0016: blog keyword trend measurements, entered by hand or imported from CSV. Every value comes
-- from an external tool chosen by the operator; nothing here is fetched. A missing value stays NULL
-- (shown as N/A), never 0. No update policy: a wrong row is deleted and entered again.

create table keyword_trends (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  -- NULL means unclassified.
  blog_id uuid,
  keyword text not null check (length(btrim(keyword)) between 1 and 120),
  -- The three keys use the same normalization as normalizePhrase in keywords.ts.
  keyword_key text generated always as (
    lower(regexp_replace(btrim(normalize(keyword, NFKC)), '\s+', ' ', 'g'))
  ) stored,
  category text not null default '' check (length(btrim(category)) <= 40),
  category_key text generated always as (
    lower(regexp_replace(btrim(normalize(category, NFKC)), '\s+', ' ', 'g'))
  ) stored,
  -- Limits are mirrored in apps/web/src/lib/trends.ts (a test compares them).
  monthly_searches bigint check (monthly_searches >= 0),
  growth_pct numeric(12, 2) check (growth_pct between -100 and 1000000),
  document_count bigint check (document_count >= 0),
  source text not null check (length(btrim(source)) between 1 and 40),
  source_key text generated always as (
    lower(regexp_replace(btrim(normalize(source, NFKC)), '\s+', ' ', 'g'))
  ) stored,
  measured_on date not null check (measured_on between date '2000-01-01' and date '2100-01-01'),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  constraint keyword_trends_has_value check (num_nonnulls(monthly_searches, growth_pct, document_count) > 0),
  -- Composite FK keeps the link inside one workspace, and a blog that is still linked can not be deleted.
  constraint keyword_trends_blog_fk foreign key (workspace_id, blog_id) references blogs (workspace_id, id),
  -- NULLS NOT DISTINCT: importing the same unclassified rows again must be a duplicate too.
  -- Its leading columns also cover the policy column and the composite FK.
  constraint keyword_trends_measurement_key
    unique nulls not distinct (workspace_id, blog_id, keyword_key, category_key, source_key, measured_on)
);
comment on table keyword_trends is 'Operator-supplied keyword measurements per blog, with source and date. Never fetched and never combined across tools.';
create index keyword_trends_ws_measured_idx on keyword_trends (workspace_id, measured_on desc);

-- Hard cap per workspace, enforced even if a client bypasses the API.
create function enforce_keyword_trend_cap() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from keyword_trends where workspace_id = new.workspace_id) >= 20000 then
    raise exception 'keyword trend limit reached (20000 per workspace)';
  end if;
  return new;
end $$;
create trigger keyword_trends_cap before insert on keyword_trends
  for each row execute function enforce_keyword_trend_cap();

alter table keyword_trends enable row level security;
create policy keyword_trends_select on keyword_trends for select to authenticated using (is_member(workspace_id));
create policy keyword_trends_insert on keyword_trends for insert to authenticated
  with check (is_member(workspace_id, array['owner','admin','editor']::workspace_role[]) and created_by = auth.uid());
create policy keyword_trends_delete on keyword_trends for delete to authenticated
  using (is_member(workspace_id, array['owner','admin','editor']::workspace_role[]));
