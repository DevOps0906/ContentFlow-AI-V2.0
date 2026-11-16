-- 0003: keywords per workspace (previously browser-only).
-- Duplicates are decided by the database with the same normalization as keywords.ts
-- (NFKC, collapsed whitespace, lower case), so a CSV re-import can never create copies.

create table keywords (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  phrase text not null check (length(btrim(phrase)) between 1 and 120),
  phrase_key text generated always as (
    lower(regexp_replace(btrim(normalize(phrase, NFKC)), '\s+', ' ', 'g'))
  ) stored,
  intent text not null default '' check (length(intent) <= 200),
  priority int not null default 3 check (priority between 1 and 5),
  note text not null default '' check (length(note) <= 500),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, phrase_key)
);
create index keywords_ws_priority_idx on keywords (workspace_id, priority, created_at);

-- Hard cap per workspace, enforced even if a client bypasses the API.
create function enforce_keyword_cap() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from keywords where workspace_id = new.workspace_id) >= 5000 then
    raise exception 'keyword limit reached (5000 per workspace)';
  end if;
  return new;
end $$;
create trigger keywords_cap before insert on keywords
  for each row execute function enforce_keyword_cap();

alter table keywords enable row level security;
create policy keywords_select on keywords for select to authenticated using (is_member(workspace_id));
create policy keywords_insert on keywords for insert to authenticated
  with check (is_member(workspace_id, array['owner','admin','editor']::workspace_role[]) and created_by = auth.uid());
create policy keywords_update on keywords for update to authenticated
  using (is_member(workspace_id, array['owner','admin','editor']::workspace_role[]))
  with check (is_member(workspace_id, array['owner','admin','editor']::workspace_role[]));
create policy keywords_delete on keywords for delete to authenticated
  using (is_member(workspace_id, array['owner','admin','editor']::workspace_role[]));