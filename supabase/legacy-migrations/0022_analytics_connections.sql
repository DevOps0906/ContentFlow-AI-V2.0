-- 0022: ad/analytics API connections (CF-07b, docs/01-planning/ANALYTICS_SYNC.md sections 3 and 5).
-- One row = one (workspace, provider, external target). It holds no token: the refresh token lives in
-- analytics_credentials (0023) and is reached through RPCs only. Members read; owner/admin create,
-- and remap the blog. The status is never written directly by a client (trigger below): it
-- changes only through the RPCs of 0023/0024/0026, and a needs_reauth connection can only come back
-- through a new consent (store_credential).
-- There is no DELETE policy: a connection is ended by disconnect_connection (0026). Without purge it
-- stays as a 'revoked' row (grant released) so the synced rows keep their connection; with purge the
-- rows and the connection go. Synced rows reference the connection without cascade, so a connection
-- that still has rows can never be deleted and leave orphans.

create table analytics_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  -- GSC / GA4: the blog the property belongs to. NULL = unclassified (AdSense maps pages to blogs later).
  blog_id uuid,
  -- Foreign key to analytics_credentials is added in 0023 (the grant table does not exist yet).
  -- NULL only for a revoked connection (its grant was released).
  grant_id uuid,
  provider text not null check (provider in ('gsc', 'adsense', 'ga4')),
  -- Property / site / account identifier shown by Google. Limited by an app-side allow list, not by Google.
  external_ref text not null check (length(btrim(external_ref)) between 1 and 500),
  -- Read-only scopes only: a write scope can not be stored.
  scopes text[] not null default '{}' check (scopes <@ array[
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/adsense.readonly',
    'https://www.googleapis.com/auth/analytics.readonly']::text[]),
  status text not null default 'pending' check (status in ('pending', 'active', 'needs_reauth', 'revoked', 'error')),
  connected_by uuid not null references auth.users (id),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  -- A code only (no token, no response body).
  last_error_code text check (last_error_code is null or length(last_error_code) <= 60),
  created_at timestamptz not null default now(),
  check (status = 'revoked' or grant_id is not null),
  unique (workspace_id, provider, external_ref),
  unique (workspace_id, id),
  -- Composite FK keeps the mapped blog inside the workspace; a blog that is still mapped can not be deleted.
  foreign key (workspace_id, blog_id) references blogs (workspace_id, id)
);
comment on table analytics_connections is 'Ad/analytics API connections per workspace. No token column; status changes only through RPCs. Members read, owner/admin write.';
create index analytics_connections_ws_grant_idx on analytics_connections (workspace_id, grant_id);
create index analytics_connections_ws_blog_idx on analytics_connections (workspace_id, blog_id);
-- Synced rows have no connection column in their row_key, so two AdSense accounts would collide: one per workspace.
-- A revoked connection (kept only for its rows) does not count.
create unique index analytics_connections_one_adsense on analytics_connections (workspace_id) where provider = 'adsense' and status <> 'revoked';
-- One GSC / GA4 connection per blog (NULL blog = the unclassified slot): two properties on one blog would write the same measurement keys.
create unique index analytics_connections_one_per_blog on analytics_connections
  (workspace_id, provider, coalesce(blog_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where provider in ('gsc', 'ga4') and status <> 'revoked';

-- Not security definer on purpose: current_user is the statement's role, so a direct client write
-- (authenticated/anon) is limited while the definer RPCs (running as the function owner) are not.
create function guard_analytics_connection() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.last_attempt_at is not null
       or new.last_success_at is not null or new.last_error_code is not null then
      raise exception 'CONNECTION_STATE_FORBIDDEN';
    end if;
    -- A grant made by someone who is no longer owner/admin can not be reused.
    if new.grant_id is null or not cf_grant_creator_active(new.workspace_id, new.grant_id) then
      raise exception 'GRANT_OWNER_INACTIVE';
    end if;
  elsif (new.workspace_id, new.grant_id, new.provider, new.external_ref, new.scopes, new.status,
         new.connected_by, new.last_attempt_at, new.last_success_at, new.last_error_code, new.created_at, new.id)
        is distinct from
        (old.workspace_id, old.grant_id, old.provider, old.external_ref, old.scopes, old.status,
         old.connected_by, old.last_attempt_at, old.last_success_at, old.last_error_code, old.created_at, old.id) then
    raise exception 'CONNECTION_STATE_FORBIDDEN';
  elsif new.blog_id is distinct from old.blog_id
        and (exists (select 1 from blog_metric_snapshots where connection_id = old.id)
             or exists (select 1 from revenue_rows where connection_id = old.id)) then
    -- Synced rows were written for the old blog; they must not silently move.
    raise exception 'CONNECTION_HAS_DATA';
  end if;
  return new;
end $$;
create trigger analytics_connections_guard before insert or update on analytics_connections
  for each row execute function guard_analytics_connection();

alter table analytics_connections enable row level security;
create policy analytics_connections_select on analytics_connections for select to authenticated
  using (is_member(workspace_id));
create policy analytics_connections_insert on analytics_connections for insert to authenticated
  with check (is_member(workspace_id, array['owner','admin']::workspace_role[]) and connected_by = auth.uid());
create policy analytics_connections_update on analytics_connections for update to authenticated
  using (is_member(workspace_id, array['owner','admin']::workspace_role[]))
  with check (is_member(workspace_id, array['owner','admin']::workspace_role[]));
