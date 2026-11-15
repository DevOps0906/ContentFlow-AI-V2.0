-- 0027: the app chooses the grant id (CF-07b A2, ANALYTICS_SYNC.md D2).
-- The ciphertext is bound to grant_id by AES-GCM AAD, so the app must know the id before it encrypts.
--  * store_credential takes the grant id. A new grant is stored with that id and the ciphertext as given.
--    When the (workspace, google_sub, client) grant already exists its id is returned and its ciphertext is
--    NOT replaced: the caller (a new consent) becomes created_by, needs_reauth connections of the grant go back
--    to pending, and the app swaps the ciphertext with rotate_credential (compare-and-set on key_version).
--  * read_credential / read_grant_credential also return google_sub, so the AAD (grant_id, workspace_id,
--    google_sub, key_version) comes from the database and nothing is carried inside the envelope.
-- Same rules as 0023: security definer, fixed search_path, owner/admin check, EXECUTE for authenticated only,
-- no set_config('role') / SET ROLE.

drop function store_credential(uuid, text, text, text, int);
drop function read_credential(uuid);
drop function read_grant_credential(uuid);

create function store_credential(p_workspace uuid, p_grant_id uuid, p_google_sub text, p_client_id text, p_ciphertext text, p_key_version int)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare g uuid;
begin
  perform cf_analytics_require_admin(p_workspace);
  if p_grant_id is null then raise exception 'ANALYTICS_GRANT_ID_REQUIRED'; end if;
  insert into analytics_credentials as c (grant_id, workspace_id, google_sub, client_id, ciphertext, key_version, created_by)
    values (p_grant_id, p_workspace, p_google_sub, p_client_id, p_ciphertext, p_key_version, auth.uid())
    on conflict (workspace_id, google_sub, client_id) do nothing
    returning c.grant_id into g;
  if g is null then
    -- Existing grant: a renewal. Keep its ciphertext; the caller becomes the consenting user.
    update analytics_credentials set created_by = auth.uid(), updated_at = now()
      where workspace_id = p_workspace and google_sub = p_google_sub and client_id = p_client_id
      returning grant_id into g;
  end if;
  update analytics_connections set status = 'pending', last_error_code = null
    where workspace_id = p_workspace and grant_id = g and status = 'needs_reauth';
  insert into audit_logs (workspace_id, actor_id, action, payload)
    values (p_workspace, auth.uid(), 'analytics.credential_stored', jsonb_build_object('grant_id', g, 'key_version', p_key_version));
  return g;
end $$;

create function read_credential(p_connection uuid)
returns table (grant_id uuid, ciphertext text, key_version int, provider text, workspace_id uuid, google_sub text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare con analytics_connections;
begin
  select * into con from analytics_connections where id = p_connection;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform cf_analytics_require_admin(con.workspace_id);
  if con.status not in ('pending', 'active', 'error') then raise exception 'CONNECTION_NOT_ACTIVE'; end if;
  if not cf_grant_creator_active(con.workspace_id, con.grant_id) then raise exception 'GRANT_OWNER_INACTIVE'; end if;
  return query select c.grant_id, c.ciphertext, c.key_version, con.provider, c.workspace_id, c.google_sub
    from analytics_credentials c where c.workspace_id = con.workspace_id and c.grant_id = con.grant_id;
end $$;

create function read_grant_credential(p_grant uuid)
returns table (grant_id uuid, ciphertext text, key_version int, workspace_id uuid, google_sub text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare ws uuid;
begin
  select c.workspace_id into ws from analytics_credentials c where c.grant_id = p_grant;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform cf_analytics_require_admin(ws);
  -- A grant whose consenting user was removed or demoted hands out no token (it needs a new consent).
  if not cf_grant_creator_active(ws, p_grant) then raise exception 'GRANT_OWNER_INACTIVE'; end if;
  return query select c.grant_id, c.ciphertext, c.key_version, c.workspace_id, c.google_sub from analytics_credentials c where c.grant_id = p_grant;
end $$;

-- Revoke path: the token of a grant that no live connection uses, for any owner/admin of the workspace.
-- No creator check on purpose: removing access must stay possible after the consenting admin was demoted
-- or removed (a token that can not be cleaned up stays alive at Google).
create function read_grant_for_revoke(p_grant uuid)
returns table (grant_id uuid, ciphertext text, key_version int, workspace_id uuid, google_sub text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare ws uuid;
begin
  select c.workspace_id into ws from analytics_credentials c where c.grant_id = p_grant;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform cf_analytics_require_admin(ws);
  if exists (select 1 from analytics_connections k where k.workspace_id = ws and k.grant_id = p_grant and k.status <> 'revoked') then
    raise exception 'GRANT_IN_USE';
  end if;
  return query select c.grant_id, c.ciphertext, c.key_version, c.workspace_id, c.google_sub from analytics_credentials c where c.grant_id = p_grant;
end $$;

revoke all on function store_credential(uuid, uuid, text, text, text, int), read_credential(uuid), read_grant_credential(uuid), read_grant_for_revoke(uuid) from public, anon, authenticated;
grant execute on function store_credential(uuid, uuid, text, text, text, int), read_credential(uuid), read_grant_credential(uuid), read_grant_for_revoke(uuid) to authenticated;
