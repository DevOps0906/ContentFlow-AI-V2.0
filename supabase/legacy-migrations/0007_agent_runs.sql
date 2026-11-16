-- 0007: AI call log (P0-05). One row per finished call, written with the caller's session.
-- Members can write it, so it is an operating reference only: never a billing or settlement
-- source. NULL tokens/cost mean the provider reported no usage or no price is set (N/A, not 0).

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  task text not null check (task in ('draft', 'review')),
  model text not null check (length(btrim(model)) between 1 and 200),
  prompt_version text not null check (length(btrim(prompt_version)) between 1 and 50),
  status text not null check (status in ('succeeded', 'failed', 'timeout')),
  tokens_in int check (tokens_in is null or tokens_in >= 0),
  tokens_out int check (tokens_out is null or tokens_out >= 0),
  duration_ms int not null check (duration_ms >= 0),
  cost_estimate numeric(18, 8) check (cost_estimate is null or cost_estimate >= 0),
  cost_currency text check (cost_currency ~ '^[A-Z]{3}$'),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  check ((cost_estimate is null) = (cost_currency is null)),
  check (cost_estimate is null or (tokens_in is not null and tokens_out is not null))
);
comment on table agent_runs is 'AI draft/review call log. Operating reference only, not a billing source.';
create index agent_runs_ws_created_idx on agent_runs (workspace_id, created_at desc);

alter table agent_runs enable row level security;
create policy agent_runs_select on agent_runs for select to authenticated using (is_member(workspace_id));
-- No update or delete policy: a run is written once when the call ends.
create policy agent_runs_insert on agent_runs for insert to authenticated
  with check (is_member(workspace_id, array['owner','admin','editor','reviewer']::workspace_role[]) and created_by = auth.uid());
