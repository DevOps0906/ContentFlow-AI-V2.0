-- 0023: refresh-token grants and the credential RPCs (CF-07b, ANALYTICS_SYNC.md sections 3, 5, D2).
-- A grant = (workspace, Google account sub, OAuth client). The app server encrypts (AES-GCM); the DB
-- only stores the ciphertext and key_version and never decrypts. No policy and no table privilege for
-- clients: every access is a security definer RPC that checks the session user is owner/admin of the
-- workspace. EXECUTE goes to authenticated only. These functions must not call set_config('role') or
-- SET ROLE (0019 cf_caller_is_client reads that setting).

create table analytics_credentials (
  grant_id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  google_sub text not null check (length(google_sub) between 1 and 255),
  client_id text not null check (length(client_id) between 1 and 255),
  ciphertext text not null check (length(ciphertext) between 1 and 8000),
  key_version int not null check (key_version >= 1),
  -- The user whose consent created/renewed it: leaving or losing owner/admin invalidates it (trigger below).
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, google_sub, client_id),
  unique (workspace_id, grant_id)
);
comment on table analytics_credentials is 'Encrypted Google refresh tokens (ciphertext + key_version only). RLS on, no policy, no client privilege: reached only through the credential RPCs.';
create index analytics_credentials_creator_idx on analytics_credentials (workspace_id, created_by);
alter table analytics_credentials enable row level security;
revoke all on analytics_credentials from anon, authenticated;

-- A grant can not be deleted while a connection uses it.
alter table analytics_connections add constraint analytics_connections_grant_fk
  foreign key (workspace_id, grant_id) references analytics_credentials (workspace_id, grant_id);

-- Shared check of every analytics RPC: a signed-in session user who is owner/admin of the workspace.
create function cf_analytics_require_admin(ws uuid) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or ws is null or not is_member(ws, array['owner','admin']::workspace_role[]) then
    raise exception 'ANALYTICS_FORBIDDEN';
  end if;
end $$;
revoke all on function cf_analytics_require_admin(uuid) from public, anon, authenticated;

-- True when the user who made the grant is still owner/admin of the workspace. Callable by members
-- (the connection guard trigger runs as the client).
create function cf_grant_creator_active(ws uuid, g uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and is_member(ws) and exists (
    select 1 from analytics_credentials c
      join memberships m on m.workspace_id = c.workspace_id and m.user_id = c.created_by
    where c.workspace_id = ws and c.grant_id = g and m.role in ('owner', 'admin'))
$$;
revoke all on function cf_grant_creator_active(uuid, uuid) from public, anon, authenticated;
grant execute on function cf_grant_creator_active(uuid, uuid) to authenticated;

-- ---------- RPCs ----------
-- Stores (or renews, after a new consent) the grant of a Google account. A renewal makes the caller the
-- consenting user and puts that grant's needs_reauth connections back to pending (they turn active on
-- the next successful sync). Returns the grant id.
create function store_credential(p_workspace uuid, p_google_sub text, p_client_id text, p_ciphertext text, p_key_version int)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare g uuid;
begin
  perform cf_analytics_require_admin(p_workspace);
  insert into analytics_credentials as c (workspace_id, google_sub, client_id, ciphertext, key_version, created_by)
    values (p_workspace, p_google_sub, p_client_id, p_ciphertext, p_key_version, auth.uid())
    on conflict (workspace_id, google_sub, client_id) do update
      set ciphertext = excluded.ciphertext, key_version = excluded.key_version,
          created_by = auth.uid(), updated_at = now()
    returning c.grant_id into g;
  update analytics_connections set status = 'pending', last_error_code = null
    where workspace_id = p_workspace and grant_id = g and status = 'needs_reauth';
  insert into audit_logs (workspace_id, actor_id, action, payload)
    values (p_workspace, auth.uid(), 'analytics.credential_stored', jsonb_build_object('grant_id', g, 'key_version', p_key_version));
  return g;
end $$;

-- The ciphertext a sync needs, by connection. Refused for a connection that needs a new consent or is revoked.
create function read_credential(p_connection uuid)
returns table (grant_id uuid, ciphertext text, key_version int, provider text, workspace_id uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare con analytics_connections;
begin
  select * into con from analytics_connections where id = p_connection;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform cf_analytics_require_admin(con.workspace_id);
  if con.status not in ('pending', 'active', 'error') then raise exception 'CONNECTION_NOT_ACTIVE'; end if;
  if not cf_grant_creator_active(con.workspace_id, con.grant_id) then raise exception 'GRANT_OWNER_INACTIVE'; end if;
  return query select c.grant_id, c.ciphertext, c.key_version, con.provider, c.workspace_id
    from analytics_credentials c where c.workspace_id = con.workspace_id and c.grant_id = con.grant_id;
end $$;

-- Key rotation (section 5): list grants with their key_version, read one by grant, swap it compare-and-set.
create function list_credential_versions(p_workspace uuid)
returns table (grant_id uuid, key_version int)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  perform cf_analytics_require_admin(p_workspace);
  return query select c.grant_id, c.key_version from analytics_credentials c where c.workspace_id = p_workspace order by c.created_at;
end $$;

create function read_grant_credential(p_grant uuid)
returns table (grant_id uuid, ciphertext text, key_version int, workspace_id uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare ws uuid;
begin
  select c.workspace_id into ws from analytics_credentials c where c.grant_id = p_grant;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform cf_analytics_require_admin(ws);
  return query select c.grant_id, c.ciphertext, c.key_version, c.workspace_id from analytics_credentials c where c.grant_id = p_grant;
end $$;

-- True when swapped; false when the stored key_version is no longer p_expected_version (someone else rotated it).
create function rotate_credential(p_grant uuid, p_expected_version int, p_ciphertext text, p_new_version int)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare ws uuid; n int;
begin
  select workspace_id into ws from analytics_credentials where grant_id = p_grant;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform cf_analytics_require_admin(ws);
  update analytics_credentials set ciphertext = p_ciphertext, key_version = p_new_version, updated_at = now()
    where grant_id = p_grant and key_version = p_expected_version;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- Only after Google accepted the revoke call: a grant that a connection still uses is never deleted.
create function delete_credential(p_grant uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare ws uuid;
begin
  select workspace_id into ws from analytics_credentials where grant_id = p_grant;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform cf_analytics_require_admin(ws);
  if exists (select 1 from analytics_connections where workspace_id = ws and grant_id = p_grant) then
    raise exception 'GRANT_IN_USE';
  end if;
  delete from analytics_credentials where grant_id = p_grant;
  insert into audit_logs (workspace_id, actor_id, action, payload)
    values (ws, auth.uid(), 'analytics.credential_deleted', jsonb_build_object('grant_id', p_grant));
end $$;

revoke all on function store_credential(uuid, text, text, text, int), read_credential(uuid),
  list_credential_versions(uuid), read_grant_credential(uuid), rotate_credential(uuid, int, text, int),
  delete_credential(uuid) from public, anon, authenticated;
grant execute on function store_credential(uuid, text, text, text, int), read_credential(uuid),
  list_credential_versions(uuid), read_grant_credential(uuid), rotate_credential(uuid, int, text, int),
  delete_credential(uuid) to authenticated;

-- ---------- member changes ----------
-- A member who is removed or is no longer owner/admin takes their consent with them: connections on a
-- grant they created need a new consent. Same transaction as the membership change, no deferred check.
create function analytics_member_changed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.role in ('owner', 'admin') and (tg_op = 'DELETE' or new.role not in ('owner', 'admin')) then
    update analytics_connections k set status = 'needs_reauth'
      where k.workspace_id = old.workspace_id and k.status in ('pending', 'active', 'error')
        and k.grant_id in (select c.grant_id from analytics_credentials c
                           where c.workspace_id = old.workspace_id and c.created_by = old.user_id);
  end if;
  return null;
end $$;
create trigger memberships_analytics_changed after update of role or delete on memberships
  for each row execute function analytics_member_changed();
