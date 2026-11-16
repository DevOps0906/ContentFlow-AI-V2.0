-- 0001_core_tenancy.sql
-- M0 core: workspaces, memberships, blogs, sources, articles, versions, approvals, audit logs.
-- Tenant boundary is enforced by composite FKs (workspace_id, id) and RLS.
-- Not applied to any live project yet. Validate with supabase/tests/rls.sql.

create extension if not exists pgcrypto;

-- ---------- enums ----------
create type workspace_role as enum ('owner', 'admin', 'editor', 'reviewer', 'viewer');
create type blog_platform as enum ('wordpress', 'tistory', 'blogger', 'naver');
create type article_state as enum (
  'idea', 'researching', 'briefing', 'drafting', 'qa_pending', 'needs_revision',
  'approval_pending', 'approved', 'export_ready', 'manual_pending', 'publishing',
  'publish_failed', 'draft_created', 'published', 'monitoring', 'update_due'
);
create type approval_decision as enum ('approved', 'rejected');

-- ---------- tables ----------
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  owner_id uuid not null references auth.users (id),
  plan text not null default 'free',
  created_at timestamptz not null default now()
);

create table memberships (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role workspace_role not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index memberships_user_idx on memberships (user_id);

create table blogs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  platform blog_platform not null,
  domain text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  url text not null check (url ~* '^https?://'),
  title text,
  checked_at timestamptz,
  license_note text,
  unique (workspace_id, id),
  unique (workspace_id, url)
);

create table articles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  owner_id uuid not null references auth.users (id),
  blog_id uuid,
  state article_state not null default 'idea',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, blog_id) references blogs (workspace_id, id)
);
create index articles_ws_state_idx on articles (workspace_id, state);

create table article_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  article_id uuid not null,
  version int not null check (version > 0),
  title text not null,
  markdown text not null,
  source_id uuid,
  content_hash text not null,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (article_id, version),
  foreign key (workspace_id, article_id) references articles (workspace_id, id) on delete cascade,
  foreign key (workspace_id, source_id) references sources (workspace_id, id)
);

create table approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  article_version_id uuid not null,
  reviewer_id uuid not null references auth.users (id),
  decision approval_decision not null,
  snapshot_hash text not null,
  decided_at timestamptz not null default now(),
  foreign key (workspace_id, article_version_id) references article_versions (workspace_id, id)
);

create table audit_logs (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references workspaces (id) on delete cascade,
  actor_id uuid references auth.users (id),
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_ws_idx on audit_logs (workspace_id, created_at desc);

-- ---------- helpers ----------
-- security definer + fixed search_path so policies can read memberships without recursion.
create function is_member(ws uuid, roles workspace_role[] default null)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m
    where m.workspace_id = ws
      and m.user_id = auth.uid()
      and (roles is null or m.role = any (roles))
  );
$$;
revoke all on function is_member(uuid, workspace_role[]) from public;
grant execute on function is_member(uuid, workspace_role[]) to authenticated;

-- ---------- immutability ----------
-- Approved snapshots: versions never change; approvals and audit logs are append-only.
create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% on % is not allowed (append-only)', tg_op, tg_table_name;
end $$;

create trigger article_versions_immutable before update or delete on article_versions
  for each row execute function forbid_mutation();
create trigger approvals_immutable before update or delete on approvals
  for each row execute function forbid_mutation();
create trigger audit_logs_immutable before update or delete on audit_logs
  for each row execute function forbid_mutation();

-- ---------- RLS ----------
alter table workspaces enable row level security;
alter table memberships enable row level security;
alter table blogs enable row level security;
alter table sources enable row level security;
alter table articles enable row level security;
alter table article_versions enable row level security;
alter table approvals enable row level security;
alter table audit_logs enable row level security;

-- workspaces: members read; owner creates; owner/admin update; only owner deletes.
create policy ws_select on workspaces for select to authenticated using (is_member(id));
create policy ws_insert on workspaces for insert to authenticated with check (owner_id = auth.uid());
create policy ws_update on workspaces for update to authenticated
  using (is_member(id, array['owner','admin']::workspace_role[]))
  with check (is_member(id, array['owner','admin']::workspace_role[]));
create policy ws_delete on workspaces for delete to authenticated using (owner_id = auth.uid());

-- memberships: members see peers; owner/admin manage. The creator bootstraps via trigger below.
create policy mem_select on memberships for select to authenticated using (is_member(workspace_id));
create policy mem_write on memberships for all to authenticated
  using (is_member(workspace_id, array['owner','admin']::workspace_role[]))
  with check (is_member(workspace_id, array['owner','admin']::workspace_role[]));

create function add_owner_membership() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into memberships (workspace_id, user_id, role) values (new.id, new.owner_id, 'owner');
  return new;
end $$;
create trigger workspaces_owner_membership after insert on workspaces
  for each row execute function add_owner_membership();

-- blogs: owner/admin manage; all members read.
create policy blogs_select on blogs for select to authenticated using (is_member(workspace_id));
create policy blogs_write on blogs for all to authenticated
  using (is_member(workspace_id, array['owner','admin']::workspace_role[]))
  with check (is_member(workspace_id, array['owner','admin']::workspace_role[]));

-- sources: editors and above write; all members read.
create policy sources_select on sources for select to authenticated using (is_member(workspace_id));
create policy sources_write on sources for all to authenticated
  using (is_member(workspace_id, array['owner','admin','editor']::workspace_role[]))
  with check (is_member(workspace_id, array['owner','admin','editor']::workspace_role[]));

-- articles: editors and above write; viewers/reviewers read.
create policy articles_select on articles for select to authenticated using (is_member(workspace_id));
create policy articles_insert on articles for insert to authenticated
  with check (is_member(workspace_id, array['owner','admin','editor']::workspace_role[]) and owner_id = auth.uid());
create policy articles_update on articles for update to authenticated
  using (is_member(workspace_id, array['owner','admin','editor']::workspace_role[]))
  with check (is_member(workspace_id, array['owner','admin','editor']::workspace_role[]));
create policy articles_delete on articles for delete to authenticated
  using (is_member(workspace_id, array['owner','admin']::workspace_role[]));

-- article_versions: insert only (immutable), by editors and above.
create policy versions_select on article_versions for select to authenticated using (is_member(workspace_id));
create policy versions_insert on article_versions for insert to authenticated
  with check (is_member(workspace_id, array['owner','admin','editor']::workspace_role[]) and created_by = auth.uid());

-- approvals: reviewers/admins/owners decide; viewers and editors cannot self-approve.
create policy approvals_select on approvals for select to authenticated using (is_member(workspace_id));
create policy approvals_insert on approvals for insert to authenticated
  with check (is_member(workspace_id, array['owner','admin','reviewer']::workspace_role[]) and reviewer_id = auth.uid());

-- audit_logs: members read; written by server (service_role bypasses RLS) or members as themselves.
create policy audit_select on audit_logs for select to authenticated
  using (is_member(workspace_id, array['owner','admin']::workspace_role[]));
create policy audit_insert on audit_logs for insert to authenticated
  with check (is_member(workspace_id) and actor_id = auth.uid());
