-- 0004: team invitations, role management, reviewer approval.
-- Membership rows are no longer writable by clients: an admin could previously insert
-- (workspace, user, 'owner') directly. All changes now go through the functions below, which
-- check who may grant which role. Invitations are bound to a confirmed email address.

drop policy mem_write on memberships;

create table invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  email text not null check (length(email) between 3 and 254),
  email_key text generated always as (lower(btrim(email))) stored,
  role workspace_role not null check (role <> 'owner'),
  invited_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (workspace_id, email_key)
);
alter table invitations enable row level security;
-- Owner/admin see their workspace's invitations; an invitee sees invitations for their own email.
-- There are no write policies: writes only happen through the functions below.
create policy invitations_select on invitations for select to authenticated using (
  is_member(workspace_id, array['owner','admin']::workspace_role[])
  or email_key = lower(coalesce(auth.jwt() ->> 'email', ''))
);

create function my_role(ws uuid) returns workspace_role
language sql stable security definer set search_path = public as $$
  select role from memberships where workspace_id = ws and user_id = auth.uid();
$$;

create function invite_member(ws uuid, p_email text, p_role workspace_role) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me workspace_role := my_role(ws);
  key text := lower(btrim(p_email));
  inv uuid;
begin
  if me is null or me not in ('owner', 'admin') then raise exception 'not allowed'; end if;
  if p_role = 'owner' then raise exception 'the owner role can not be granted'; end if;
  if p_role = 'admin' and me <> 'owner' then raise exception 'only the owner can invite admins'; end if;
  if key !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or length(key) > 254 then raise exception 'invalid email'; end if;
  if exists (select 1 from memberships m join auth.users u on u.id = m.user_id
             where m.workspace_id = ws and lower(u.email) = key) then
    raise exception 'already a member';
  end if;
  insert into invitations (workspace_id, email, role, invited_by) values (ws, key, p_role, auth.uid())
    on conflict (workspace_id, email_key) do update
      set role = excluded.role, invited_by = excluded.invited_by, created_at = now(), accepted_at = null
    returning id into inv;
  insert into audit_logs (workspace_id, actor_id, action, payload)
    values (ws, auth.uid(), 'member.invited', jsonb_build_object('email', key, 'role', p_role));
  return inv;
end $$;

-- Invitations addressed to the caller. Only confirmed emails: with email confirmation off an
-- attacker could register someone else's address and accept their invitation.
create function my_invitations()
returns table (id uuid, workspace_name text, role workspace_role, invited_by_email text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select i.id, w.name, i.role, u.email::text, i.created_at
  from invitations i
  join workspaces w on w.id = i.workspace_id
  join auth.users u on u.id = i.invited_by
  where i.accepted_at is null
    and i.email_key = (select lower(me.email) from auth.users me where me.id = auth.uid() and me.email_confirmed_at is not null)
  order by i.created_at desc;
$$;

create function accept_invitation(inv uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare i invitations; ws uuid;
begin
  select * into i from invitations
    where id = inv and accepted_at is null
      and email_key = (select lower(me.email) from auth.users me where me.id = auth.uid() and me.email_confirmed_at is not null);
  if not found then raise exception 'invitation not found'; end if;
  insert into memberships (workspace_id, user_id, role) values (i.workspace_id, auth.uid(), i.role)
    on conflict (workspace_id, user_id) do nothing;
  update invitations set accepted_at = now() where id = i.id;
  insert into audit_logs (workspace_id, actor_id, action, payload)
    values (i.workspace_id, auth.uid(), 'member.joined', jsonb_build_object('role', i.role));
  ws := i.workspace_id;
  return ws;
end $$;

-- Revoke (owner/admin) or decline (the invitee).
create function delete_invitation(inv uuid) returns void
language plpgsql security definer set search_path = public as $$
declare i invitations;
begin
  select * into i from invitations where id = inv;
  if not found then raise exception 'invitation not found'; end if;
  if not (is_member(i.workspace_id, array['owner','admin']::workspace_role[])
          or i.email_key = (select lower(me.email) from auth.users me where me.id = auth.uid())) then
    raise exception 'invitation not found';
  end if;
  delete from invitations where id = inv;
end $$;

create function workspace_members(ws uuid)
returns table (user_id uuid, email text, role workspace_role, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.user_id, u.email::text, m.role, m.created_at
  from memberships m join auth.users u on u.id = m.user_id
  where m.workspace_id = ws and is_member(ws)
  order by case m.role when 'owner' then 0 when 'admin' then 1 when 'editor' then 2 when 'reviewer' then 3 else 4 end, u.email;
$$;

create function change_member_role(ws uuid, target uuid, p_role workspace_role) returns void
language plpgsql security definer set search_path = public as $$
declare me workspace_role := my_role(ws); cur workspace_role;
begin
  select role into cur from memberships where workspace_id = ws and user_id = target;
  if me is null or me not in ('owner', 'admin') or cur is null then raise exception 'not allowed'; end if;
  if cur = 'owner' or p_role = 'owner' then raise exception 'the owner role can not be changed'; end if;
  if me = 'admin' and (cur = 'admin' or p_role = 'admin') then raise exception 'only the owner can manage admins'; end if;
  update memberships set role = p_role where workspace_id = ws and user_id = target;
  insert into audit_logs (workspace_id, actor_id, action, payload)
    values (ws, auth.uid(), 'member.role_changed', jsonb_build_object('user_id', target, 'from', cur, 'to', p_role));
end $$;

-- Owner/admin remove others; anyone but the owner may leave.
create function remove_member(ws uuid, target uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me workspace_role := my_role(ws); cur workspace_role;
begin
  select role into cur from memberships where workspace_id = ws and user_id = target;
  if me is null or cur is null then raise exception 'not allowed'; end if;
  if cur = 'owner' then raise exception 'the owner can not be removed'; end if;
  if target <> auth.uid() then
    if me not in ('owner', 'admin') then raise exception 'not allowed'; end if;
    if me = 'admin' and cur = 'admin' then raise exception 'only the owner can manage admins'; end if;
  end if;
  delete from memberships where workspace_id = ws and user_id = target;
  insert into audit_logs (workspace_id, actor_id, action, payload)
    values (ws, auth.uid(), 'member.removed', jsonb_build_object('user_id', target, 'role', cur));
end $$;

revoke all on function my_role(uuid), invite_member(uuid, text, workspace_role), my_invitations(),
  accept_invitation(uuid), delete_invitation(uuid), workspace_members(uuid),
  change_member_role(uuid, uuid, workspace_role), remove_member(uuid, uuid) from public;
grant execute on function my_role(uuid), invite_member(uuid, text, workspace_role), my_invitations(),
  accept_invitation(uuid), delete_invitation(uuid), workspace_members(uuid),
  change_member_role(uuid, uuid, workspace_role), remove_member(uuid, uuid) to authenticated;

-- ---------- reviewers can decide, never edit ----------
create policy articles_review on articles for update to authenticated
  using (is_member(workspace_id, array['reviewer']::workspace_role[]))
  with check (is_member(workspace_id, array['reviewer']::workspace_role[]));

create or replace function enforce_article_rules() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  planning article_state[] := array['idea','researching','briefing','drafting']::article_state[];
  gated article_state[] := array['approved','export_ready','manual_pending','publishing',
    'publish_failed','draft_created','published','monitoring','update_due']::article_state[];
  base article_state;
  changed boolean;
  ok boolean;
  ver int;
  vid uuid;
  hash text;
begin
  if tg_op = 'INSERT' then
    if not (new.state = any (planning)) then
      raise exception 'new articles must start in a planning state, not %', new.state;
    end if;
    if new.remote is not null then
      raise exception 'remote draft info can not be set on a new article';
    end if;
    return new;
  end if;

  changed := (new.title, new.keyword, new.template_id, new.platform, new.body, new.source_url)
    is distinct from (old.title, old.keyword, old.template_id, old.platform, old.body, old.source_url);
  if (new.workspace_id, new.owner_id) is distinct from (old.workspace_id, old.owner_id) then
    raise exception 'workspace and owner can not change';
  end if;

  -- Reviewers (RLS lets them update) may only decide an article that waits for approval.
  if auth.uid() is not null
     and not is_member(new.workspace_id, array['owner','admin','editor']::workspace_role[]) then
    if changed or new.remote is distinct from old.remote or new.blog_id is distinct from old.blog_id
       or not (old.state = 'approval_pending' and new.state in ('approved', 'needs_revision')) then
      raise exception 'reviewers can only approve or send back articles waiting for approval';
    end if;
  end if;

  base := case when changed and not (old.state = any (planning)) then 'drafting' else old.state end;
  ok := new.state = base
    or article_transition_allowed(base, new.state)
    or (article_transition_allowed(base, 'qa_pending')
        and new.state in ('approval_pending', 'needs_revision'));
  if not ok then
    raise exception 'state change not allowed: % → % (content changed: %)', old.state, new.state, changed;
  end if;

  if new.state = any (gated) and not article_review_ok(new) then
    raise exception 'title, body and source URL must pass review before reaching %', new.state;
  end if;
  if new.state = 'approval_pending' and not article_review_ok(new) then
    raise exception 'review failed: article can not wait for approval';
  end if;

  if new.state = 'approved' and old.state is distinct from 'approved' then
    if not is_member(new.workspace_id, array['owner','admin','reviewer']::workspace_role[]) then
      raise exception 'only owner, admin or reviewer can approve';
    end if;
    select coalesce(max(version), 0) + 1 into ver from article_versions where article_id = new.id;
    hash := encode(sha256(convert_to(
      concat_ws(E'\x1f', new.title, new.body, new.source_url, new.template_id, new.platform::text), 'UTF8')), 'hex');
    insert into article_versions (workspace_id, article_id, version, title, markdown, content_hash, created_by)
      values (new.workspace_id, new.id, ver, new.title, new.body, hash, auth.uid())
      returning id into vid;
    insert into approvals (workspace_id, article_version_id, reviewer_id, decision, snapshot_hash)
      values (new.workspace_id, vid, auth.uid(), 'approved', hash);
    insert into audit_logs (workspace_id, actor_id, action, payload)
      values (new.workspace_id, auth.uid(), 'article.approved',
              jsonb_build_object('article_id', new.id, 'version', ver, 'hash', hash));
  end if;

  new.updated_at := now();
  return new;
end $$;