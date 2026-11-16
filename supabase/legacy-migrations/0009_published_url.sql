-- 0009: public URL of a published article (P0-08).
-- Written only by the update that confirms publication. It describes the live post, so it is not
-- part of the approved content: changing it voids nothing, and going back to editing clears it so
-- the next publication has to be confirmed again. It is never copied from remote.url, which can be
-- a draft link. Rows published before this migration keep NULL.

alter table articles
  add column published_url text,
  -- Keep in sync with isPublishedUrl in apps/web/src/lib/content.ts.
  add constraint articles_published_url check (
    published_url is null or (length(published_url) <= 2000 and published_url ~* '^https?://[^[:space:]]+$')
  );
comment on column articles.published_url is 'Public URL confirmed by an operator when the article was published.';

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
