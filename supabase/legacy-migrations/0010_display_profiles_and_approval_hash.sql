-- 0010: display and ad profiles, approval hash v2, and the delivery check (P0-12, PRD #11).
-- The profiles belong to the approved output, so changing one voids the approval. The renderer
-- version is a constant of the deployed app: the app server writes it into the update that approves
-- an article and this trigger copies it into the snapshot. It can change at no other moment.
-- Older snapshots keep NULL in the new columns on purpose: they are not backfilled, and the delivery
-- check refuses them until the article is approved again.

alter table articles
  -- Keep both lists in sync with apps/web/src/lib/render.ts (a test compares them).
  add column layout_profile text not null default 'L01' check (layout_profile in ('L01', 'L02')),
  add column ad_profile text not null default 'A00' check (ad_profile in ('A00', 'A01')),
  add column renderer_version text check (renderer_version is null or length(renderer_version) <= 32);
comment on column articles.renderer_version is 'Renderer of the last approval. Written by the app server when approving.';

alter table article_versions
  add column source_url text,
  add column template_id text,
  add column platform blog_platform,
  add column layout_profile text,
  add column ad_profile text,
  add column renderer_version text,
  add column hash_version int;

-- jsonb keeps NULL and '' apart and needs no separator, which concat_ws in hash v1 could not do.
create function article_content_hash_v2(
  p_title text, p_body text, p_source_url text, p_template_id text, p_platform text,
  p_layout_profile text, p_ad_profile text, p_renderer_version text
) returns text language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'hash_version', 2,
    'title', p_title,
    'body', p_body,
    'source_url', p_source_url,
    'template_id', p_template_id,
    'platform', p_platform,
    'layout_profile', p_layout_profile,
    'ad_profile', p_ad_profile,
    'renderer_version', p_renderer_version
  )::text, 'UTF8')), 'hex');
$$;

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
    if new.published_url is not null then
      raise exception 'a public URL can not be set on a new article';
    end if;
    if new.renderer_version is not null then
      raise exception 'a renderer version can not be set on a new article';
    end if;
    return new;
  end if;

  changed := (new.title, new.keyword, new.template_id, new.platform, new.body, new.source_url, new.layout_profile, new.ad_profile)
    is distinct from (old.title, old.keyword, old.template_id, old.platform, old.body, old.source_url, old.layout_profile, old.ad_profile);
  if (new.workspace_id, new.owner_id) is distinct from (old.workspace_id, old.owner_id) then
    raise exception 'workspace and owner can not change';
  end if;

  -- Reviewers (RLS lets them update) may only decide an article that waits for approval.
  if auth.uid() is not null
     and not is_member(new.workspace_id, array['owner','admin','editor']::workspace_role[]) then
    if changed or new.remote is distinct from old.remote or new.blog_id is distinct from old.blog_id
       or new.published_url is distinct from old.published_url
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

  -- Same rule as applyPublishedUrlRule() in content.ts, for browser storage.
  if new.state = 'published' and old.state is distinct from 'published' then
    if new.published_url is null then
      raise exception 'a public URL is required to confirm publication';
    end if;
  elsif new.published_url is distinct from old.published_url then
    raise exception 'the public URL can only be set when confirming publication';
  elsif not (new.state in ('published', 'monitoring', 'update_due')) then
    new.published_url := null;
  end if;

  -- Same rule as applyRendererRule() in content.ts, for browser storage.
  if new.renderer_version is distinct from old.renderer_version
     and not (new.state = 'approved' and old.state is distinct from 'approved') then
    raise exception 'the renderer version can only be set when approving';
  end if;

  if new.state = 'approved' and old.state is distinct from 'approved' then
    if not is_member(new.workspace_id, array['owner','admin','reviewer']::workspace_role[]) then
      raise exception 'only owner, admin or reviewer can approve';
    end if;
    select coalesce(max(version), 0) + 1 into ver from article_versions where article_id = new.id;
    hash := article_content_hash_v2(new.title, new.body, new.source_url, new.template_id, new.platform::text,
      new.layout_profile, new.ad_profile, new.renderer_version);
    insert into article_versions (workspace_id, article_id, version, title, markdown, content_hash, created_by,
        source_url, template_id, platform, layout_profile, ad_profile, renderer_version, hash_version)
      values (new.workspace_id, new.id, ver, new.title, new.body, hash, auth.uid(),
        new.source_url, new.template_id, new.platform, new.layout_profile, new.ad_profile, new.renderer_version, 2)
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

-- Runs with the caller's rights: row level security decides which articles exist for them.
-- The reasons are mirrored by deliveryBlockMessages in apps/web/src/lib/delivery.ts (a test compares them).
create function article_delivery_check(p_article_id uuid, p_renderer_version text)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  gated article_state[] := array['approved','export_ready','manual_pending','publishing',
    'publish_failed','draft_created','published','monitoring','update_due']::article_state[];
  a articles;
  v article_versions;
begin
  select * into a from articles where id = p_article_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if not (a.state = any (gated)) then
    return jsonb_build_object('ok', false, 'reason', 'not_approved');
  end if;

  -- The latest snapshot that a person approved; members can insert versions but not approvals.
  select ve.* into v from article_versions ve
    join approvals ap on ap.workspace_id = ve.workspace_id and ap.article_version_id = ve.id
    where ve.article_id = a.id and ap.decision = 'approved' and ap.snapshot_hash = ve.content_hash
    order by ve.version desc limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_approval');
  end if;
  if v.hash_version is distinct from 2 then
    return jsonb_build_object('ok', false, 'reason', 'hash_version');
  end if;
  if article_content_hash_v2(a.title, a.body, a.source_url, a.template_id, a.platform::text,
       a.layout_profile, a.ad_profile, v.renderer_version) is distinct from v.content_hash then
    return jsonb_build_object('ok', false, 'reason', 'hash_mismatch');
  end if;
  if p_renderer_version is null or v.renderer_version is distinct from p_renderer_version then
    return jsonb_build_object('ok', false, 'reason', 'renderer_mismatch');
  end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function article_delivery_check(uuid, text) from public, anon;
grant execute on function article_delivery_check(uuid, text) to authenticated;
