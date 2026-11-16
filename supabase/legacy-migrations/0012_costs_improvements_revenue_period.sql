-- 0012: production cost ledger, improvement queue, and report time zone/period on revenue rows
-- (P0-13, P0-14).

-- ---------- revenue report context ----------
-- Rows imported before this migration have no recorded time zone or period and stay NULL: nothing
-- is backfilled, because the original report settings are unknown. NOT VALID applies the rule to
-- every new row only.
alter table revenue_rows
  add column timezone text,
  add column period_start date,
  add column period_end date;
alter table revenue_rows add constraint revenue_rows_report_context check (
  timezone is not null and length(timezone) between 1 and 64 and timezone ~ '^[A-Za-z0-9_+/-]+$'
  and period_start is not null and period_end is not null and period_start <= period_end
  and report_date between period_start and period_end
) not valid;
create index revenue_rows_report_idx
  on revenue_rows (workspace_id, lower(btrim(source)), status, currency, timezone, period_start, period_end);

-- A report is identified by source, status, currency, site/page level and time zone. Importing
-- exactly the same period again is allowed (row_key skips what is already stored); a different
-- period that overlaps it would mix two versions of the same days, so the whole statement fails.
-- A row with no recorded time zone can not be told apart, so any overlap with its date is refused.
create function enforce_revenue_period() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Serializes imports per workspace so two overlapping reports can not both pass this check.
  perform pg_advisory_xact_lock(hashtextextended('revenue_rows:' || w::text, 0))
    from (select distinct workspace_id w from new_rows order by 1) d;
  if exists (
    select 1
    from (
      select distinct workspace_id, lower(btrim(source)) src, status, currency, (page = '') site,
        timezone, period_start, period_end
      from new_rows
    ) n
    join revenue_rows r
      on r.workspace_id = n.workspace_id and lower(btrim(r.source)) = n.src
      and r.status = n.status and r.currency = n.currency and (r.page = '') = n.site
    where (r.timezone is null and r.report_date between n.period_start and n.period_end)
      or (
        r.timezone = n.timezone
        and not (r.period_start = n.period_start and r.period_end = n.period_end)
        and r.period_start <= n.period_end and n.period_start <= r.period_end
      )
  ) then
    raise exception 'revenue report period overlap';
  end if;
  return null;
end $$;
create trigger revenue_period after insert on revenue_rows
  referencing new table as new_rows
  for each statement execute function enforce_revenue_period();

-- ---------- cost ledger ----------
-- Manual entries only. There is deliberately no link to agent_runs: AI call estimates are shown
-- apart as a reference and can not be added to this ledger by any path. Totals are per currency.
create table cost_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  category text not null check (category in ('model', 'labor', 'hosting', 'renewal', 'other')),
  amount numeric(18, 4) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  occurred_on date not null check (occurred_on between date '2000-01-01' and date '2100-01-01'),
  provenance text not null default 'manual' check (provenance = 'manual'),
  note text check (note is null or length(note) <= 500),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);
comment on table cost_entries is 'Operator-entered production costs per workspace. Never derived from agent_runs; never summed across currencies.';
create index cost_entries_ws_occurred_idx on cost_entries (workspace_id, occurred_on desc);

-- No update policy: a wrong entry is deleted and entered again.
alter table cost_entries enable row level security;
create policy cost_entries_select on cost_entries for select to authenticated using (is_member(workspace_id));
create policy cost_entries_insert on cost_entries for insert to authenticated
  with check (is_member(workspace_id, array['owner','admin']::workspace_role[]) and created_by = auth.uid());
create policy cost_entries_delete on cost_entries for delete to authenticated
  using (is_member(workspace_id, array['owner','admin']::workspace_role[]));

-- ---------- improvement queue ----------
-- A work queue, not an automation: nothing here changes an article or publishes anything, and
-- no column claims that a change worked. The composite keys keep the article, the assignee and
-- the resulting version inside the workspace and the article.
create table improvement_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  article_id uuid not null,
  target_url text not null check (length(target_url) <= 2000 and target_url ~* '^https?://[^[:space:]]+$'),
  evidence text not null check (length(btrim(evidence)) between 1 and 2000),
  observed_from date not null,
  observed_to date not null,
  -- NULL only after the assignee leaves the workspace; a new task must name one (trigger below).
  assignee_id uuid,
  review_at date not null,
  state text not null default 'open' check (state in ('open', 'in_progress', 'done', 'cancelled')),
  result_version int check (result_version is null or result_version > 0),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (observed_from <= observed_to),
  constraint improvement_tasks_done_version check (state <> 'done' or result_version is not null),
  foreign key (workspace_id, article_id) references articles (workspace_id, id) on delete cascade,
  foreign key (workspace_id, assignee_id) references memberships (workspace_id, user_id) on delete set null (assignee_id),
  foreign key (article_id, result_version) references article_versions (article_id, version)
);
comment on table improvement_tasks is 'Evidence-based improvement work items. Never publishes or changes an article and never records an outcome claim.';
create index improvement_tasks_ws_state_idx on improvement_tasks (workspace_id, state, review_at);
create index improvement_tasks_article_idx on improvement_tasks (article_id, result_version);
create index improvement_tasks_assignee_idx on improvement_tasks (workspace_id, assignee_id);

create function stamp_improvement_task() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.assignee_id is null then
      raise exception 'an improvement task needs an assignee';
    end if;
  elsif new.workspace_id <> old.workspace_id or new.article_id <> old.article_id
    or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'an improvement task can not move or change its author';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger improvement_tasks_stamp before insert or update on improvement_tasks
  for each row execute function stamp_improvement_task();

-- No delete policy: a task that is dropped is recorded as cancelled.
alter table improvement_tasks enable row level security;
create policy improvement_tasks_select on improvement_tasks for select to authenticated using (is_member(workspace_id));
create policy improvement_tasks_insert on improvement_tasks for insert to authenticated
  with check (is_member(workspace_id, array['owner','admin','editor','reviewer']::workspace_role[]) and created_by = auth.uid());
create policy improvement_tasks_update on improvement_tasks for update to authenticated
  using (is_member(workspace_id, array['owner','admin','editor','reviewer']::workspace_role[]))
  with check (is_member(workspace_id, array['owner','admin','editor','reviewer']::workspace_role[]));
