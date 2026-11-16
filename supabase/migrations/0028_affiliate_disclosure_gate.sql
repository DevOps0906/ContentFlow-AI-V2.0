-- 0028: affiliate disclosure gate (C1, AFFILIATE_COMMERCE.md §4.1). An article with a Coupang Partners
-- link (coupa.ng, link.coupang.com) in the title or body can only be approved when the first 300 code
-- points of title + body (CRLF→LF, lines starting with '#' dropped) say that a fee is received, without
-- vague or negated wording ("받을 ?수", "받지 않"). It is a guardrail that a disclosure phrase is present,
-- not a judgement of its meaning. Only entering approval is checked: article_review_ok (0002), the transition
-- table and the approval hash do not change, so already approved or published rows keep moving.
-- The patterns match content.ts; supabase/tests/disclosure-fixtures.json runs through both.

create function affiliate_link_present(title text, body text) returns boolean language sql immutable as $$
  select (coalesce(title, '') || E'\n' || coalesce(body, ''))
    ~* '(^|[^a-z0-9-])(coupa\.ng|link\.coupang\.com)($|[^a-z0-9.-]|\.($|[^a-z0-9-]))';
$$;

create function affiliate_disclosure_window(title text, body text) returns text language sql immutable as $$
  select left(coalesce(title, '') || E'\n' || array_to_string(array(
      select t.line
      from unnest(string_to_array(replace(coalesce(body, ''), E'\r\n', E'\n'), E'\n')) with ordinality as t(line, n)
      where left(t.line, 1) <> '#'
      order by t.n), E'\n'), 300);
$$;

create function affiliate_disclosure_present(title text, body text) returns boolean language sql immutable as $$
  select w ~ '(수수료|대가|원고료)' and w ~ '(제공받|지급받|받습니다|받았)' and w !~ '(받을 ?수|받지 않)'
  from (select affiliate_disclosure_window(title, body) as w) s;
$$;

create function article_disclosure_ok(a articles) returns boolean language sql immutable as $$
  select not affiliate_link_present(a.title, a.body) or affiliate_disclosure_present(a.title, a.body);
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
       or new.keyword_id is distinct from old.keyword_id
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
  -- Every route into review counts, including an edit of a later state, which is treated as drafting.
  -- needs_revision is left open: it moves nothing forward and is how a failed QA is recorded.
  if base = 'drafting' and new.state in ('qa_pending', 'approval_pending') and not article_brief_ok(new) then
    raise exception 'purpose, audience, source URL and channel are required before review';
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
  -- Same rule as disclosureErrors() in content.ts (AFFILIATE_COMMERCE.md §4.1): checked only on the way
  -- into approval, so delivery, publication and monitoring of articles approved earlier are unaffected.
  if new.state = 'approved' and old.state is distinct from 'approved' and not (old.state = any (gated))
     and not article_disclosure_ok(new) then
    raise exception 'an affiliate link needs a payment disclosure in the first 300 characters before approval';
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
