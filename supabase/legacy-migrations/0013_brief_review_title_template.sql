-- 0013: required brief, human evidence and rights review, stored title ratings, pinned templates
-- (P0-02, 03, 04, 06). The brief is checked only by the transition that leaves `briefing`, so older
-- articles keep saving. Evidence and rights are decided by people: only owner, admin or reviewer can
-- set them, and no AI route writes these columns. The approval hash formula does not change.

alter table articles
  add column brief_purpose text not null default '' check (length(brief_purpose) <= 1000),
  add column brief_audience text not null default '' check (length(brief_audience) <= 1000),
  -- Keep both lists in sync with REVIEW_STATUSES in apps/web/src/lib/content.ts (a test compares them).
  add column evidence_status text not null default 'unreviewed'
    check (evidence_status in ('unreviewed', 'ok', 'blocked')),
  add column rights_status text not null default 'unreviewed'
    check (rights_status in ('unreviewed', 'ok', 'blocked')),
  add column title_evaluation jsonb,
  add column template_version text,
  add constraint articles_title_evaluation_shape check (
    title_evaluation is null or (
      case when jsonb_typeof(title_evaluation) = 'array' then jsonb_array_length(title_evaluation) = 5 else false end
      and length(title_evaluation::text) <= 10000
    )
  ),
  add constraint articles_template_version_shape check (
    template_version is null or (
      template_version ~ '^T[0-9]{2}@[0-9]+$' and split_part(template_version, '@', 1) = template_id
    )
  );
comment on column articles.template_version is 'Template version pinned by the app server when the template is chosen. NULL on older rows.';

-- Older snapshots keep NULL: they are not backfilled.
alter table article_versions add column template_version text;

-- Same checks as briefErrors() in content.ts. `platform` is a NOT NULL enum, so the channel is always set.
create function article_brief_ok(a articles) returns boolean language sql immutable set search_path = public as $$
  select btrim(a.brief_purpose) <> ''
    and btrim(a.brief_audience) <> ''
    and a.source_url ~* '^https?://[^ ]+$'
    and a.platform is not null;
$$;

create or replace function enforce_article_rules() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  planning article_state[] := array['idea','researching','briefing','drafting']::article_state[];
  gated article_state[] := array['approved','export_ready','manual_pending','publishing',
    'publish_failed','draft_created','published','monitoring','update_due']::article_state[];
  base article_state;
  changed boolean;
  review_changed boolean;
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
    if new.evidence_status <> 'unreviewed' or new.rights_status <> 'unreviewed' then
      raise exception 'a new article starts with evidence and rights unreviewed';
    end if;
    return new;
  end if;

  -- The brief is part of what was reviewed. Title ratings are not: they never void an approval.
  changed := (new.title, new.keyword, new.template_id, new.platform, new.body, new.source_url, new.layout_profile, new.ad_profile, new.brief_purpose, new.brief_audience)
    is distinct from (old.title, old.keyword, old.template_id, old.platform, old.body, old.source_url, old.layout_profile, old.ad_profile, old.brief_purpose, old.brief_audience);
  review_changed := (new.evidence_status, new.rights_status) is distinct from (old.evidence_status, old.rights_status);
  if (new.workspace_id, new.owner_id) is distinct from (old.workspace_id, old.owner_id) then
    raise exception 'workspace and owner can not change';
  end if;

  if review_changed then
    if not is_member(new.workspace_id, array['owner','admin','reviewer']::workspace_role[]) then
      raise exception 'only owner, admin or reviewer can set evidence and rights status';
    end if;
    if old.state = any (gated) then
      raise exception 'evidence and rights status can not change after approval';
    end if;
  end if;

  -- Reviewers (RLS lets them update) may only decide an article that waits for approval.
  if auth.uid() is not null
     and not is_member(new.workspace_id, array['owner','admin','editor']::workspace_role[]) then
    if changed or new.remote is distinct from old.remote or new.blog_id is distinct from old.blog_id
       or new.published_url is distinct from old.published_url
       or new.title_evaluation is distinct from old.title_evaluation
       or not (old.state = 'approval_pending'
               and (new.state in ('approved', 'needs_revision') or (new.state = old.state and review_changed))) then
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

  -- Same rule as applyBriefRule() in content.ts, for browser storage.
  if old.state = 'briefing' and new.state <> 'briefing' and not article_brief_ok(new) then
    raise exception 'purpose, audience, source URL and channel are required to leave the brief';
  end if;

  -- Same rule as applyReviewRule() in content.ts: a person confirmed the older content, not this one.
  if changed then
    new.evidence_status := 'unreviewed';
    new.rights_status := 'unreviewed';
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

  -- Same rule as applyTemplateVersionRule() in content.ts, for browser storage.
  if new.template_version is distinct from old.template_version and new.template_id is not distinct from old.template_id then
    raise exception 'the template version is fixed when the template is chosen';
  end if;

  if new.state = 'approved' and old.state is distinct from 'approved' then
    if not is_member(new.workspace_id, array['owner','admin','reviewer']::workspace_role[]) then
      raise exception 'only owner, admin or reviewer can approve';
    end if;
    if new.evidence_status <> 'ok' or new.rights_status <> 'ok' then
      raise exception 'evidence and rights must both be confirmed before approval';
    end if;
    select coalesce(max(version), 0) + 1 into ver from article_versions where article_id = new.id;
    hash := article_content_hash_v2(new.title, new.body, new.source_url, new.template_id, new.platform::text,
      new.layout_profile, new.ad_profile, new.renderer_version);
    insert into article_versions (workspace_id, article_id, version, title, markdown, content_hash, created_by,
        source_url, template_id, platform, layout_profile, ad_profile, renderer_version, hash_version, template_version)
      values (new.workspace_id, new.id, ver, new.title, new.body, hash, auth.uid(),
        new.source_url, new.template_id, new.platform, new.layout_profile, new.ad_profile, new.renderer_version, 2, new.template_version)
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
