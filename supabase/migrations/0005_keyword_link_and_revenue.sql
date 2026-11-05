-- 0005: articles link to keywords by id; revenue report rows move to the database.

-- ---------- keyword link ----------
-- Composite FK keeps the link inside one workspace. Deleting a keyword keeps the article.
alter table articles add column keyword_id uuid;
alter table articles add constraint articles_keyword_fk
  foreign key (workspace_id, keyword_id) references keywords (workspace_id, id) on delete set null (keyword_id);
create index articles_keyword_idx on articles (workspace_id, keyword_id);

-- Backfill from the old phrase match. The lifecycle trigger is not about links, so it is skipped.
alter table articles disable trigger articles_rules;
update articles a set keyword_id = k.id
from keywords k
where a.keyword_id is null
  and k.workspace_id = a.workspace_id
  and k.phrase_key = lower(regexp_replace(btrim(normalize(a.keyword, NFKC)), '\s+', ' ', 'g'));
alter table articles enable trigger articles_rules;

-- ---------- revenue rows ----------
-- row_key is computed by the app (source+status+currency+date+normalized page) and makes
-- re-importing the same report a no-op. Amounts keep their meaning: estimated and finalized
-- are separate rows and are never merged here.
create table revenue_rows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  row_key text not null check (length(row_key) between 1 and 1200),
  source text not null check (length(btrim(source)) between 1 and 40),
  status text not null check (status in ('estimated', 'finalized')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  report_date date not null check (report_date between date '2000-01-01' and date '2100-01-01'),
  page text not null default '' check (length(page) <= 500),
  revenue numeric(18, 4) check (revenue is null or revenue >= 0),
  pageviews bigint check (pageviews is null or pageviews >= 0),
  impressions bigint check (impressions is null or impressions >= 0),
  clicks bigint check (clicks is null or clicks >= 0),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  check (revenue is not null or pageviews is not null or impressions is not null or clicks is not null),
  unique (workspace_id, row_key)
);
create index revenue_rows_ws_date_idx on revenue_rows (workspace_id, report_date);

create function enforce_revenue_cap() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from revenue_rows where workspace_id = new.workspace_id) >= 20000 then
    raise exception 'revenue row limit reached (20000 per workspace)';
  end if;
  return new;
end $$;
create trigger revenue_cap before insert on revenue_rows
  for each row execute function enforce_revenue_cap();

alter table revenue_rows enable row level security;
create policy revenue_select on revenue_rows for select to authenticated using (is_member(workspace_id));
create policy revenue_insert on revenue_rows for insert to authenticated
  with check (is_member(workspace_id, array['owner','admin']::workspace_role[]) and created_by = auth.uid());
create policy revenue_delete on revenue_rows for delete to authenticated
  using (is_member(workspace_id, array['owner','admin']::workspace_role[]));