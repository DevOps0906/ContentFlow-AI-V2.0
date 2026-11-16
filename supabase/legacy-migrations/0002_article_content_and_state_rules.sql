-- 0002: working copy of the article + server-enforced lifecycle.
-- The app talks to the DB with the user's own JWT, so RLS alone (role check) would let an
-- editor write `state = 'approved'` directly. This trigger makes the DB the authority:
-- transitions must follow the same table as apps/web/src/lib/lifecycle.ts (a test compares them),
-- content edits void approvals, and approving writes an immutable snapshot + approval row.

alter table articles
  add column title text not null default '',
  add column keyword text not null default '',
  add column template_id text not null default 'T01',
  add column platform blog_platform not null default 'wordpress',
  add column body text not null default '',
  add column source_url text not null default '',
  add column remote jsonb,
  add constraint articles_remote_shape check (
    remote is null or (jsonb_typeof(remote) = 'object' and remote ? 'postId' and remote ? 'url')
  ),
  add constraint articles_size check (length(title) <= 300 and length(body) <= 200000 and length(source_url) <= 2000);

-- ---------- lifecycle table (keep in sync with lifecycle.ts) ----------
create function article_transition_allowed(a article_state, b article_state)
returns boolean language sql immutable as $$
  select (a, b) in (
    ('idea', 'researching'),
    ('researching', 'briefing'),
    ('briefing', 'drafting'),
    ('drafting', 'qa_pending'),
    ('qa_pending', 'needs_revision'), ('qa_pending', 'approval_pending'),
    ('needs_revision', 'drafting'),
    ('approval_pending', 'approved'), ('approval_pending', 'needs_revision'),
    ('approved', 'export_ready'), ('approved', 'drafting'),
    ('export_ready', 'manual_pending'), ('export_ready', 'publishing'), ('export_ready', 'drafting'),
    ('manual_pending', 'published'), ('manual_pending', 'export_ready'),
    ('publishing', 'draft_created'), ('publishing', 'publish_failed'),
    ('publish_failed', 'publishing'), ('publish_failed', 'manual_pending'), ('publish_failed', 'drafting'),
    ('draft_created', 'published'), ('draft_created', 'drafting'),
    ('published', 'monitoring'), ('published', 'update_due'),
    ('monitoring', 'update_due'),
    ('update_due', 'drafting')
  );
$$;

-- Same checks as reviewErrors() in content.ts.
create function article_review_ok(a articles) returns boolean language sql immutable as $$
  select btrim(a.title) <> ''
    and a.source_url ~* '^https?://[^ ]+$'
    and btrim(regexp_replace(a.body, '(^|\n)#[^\n]*', '', 'g')) <> ''
    and a.body !~ '\[(출처 )?확인 필요|\[직접 경험 작성';
$$;

create function enforce_article_rules() returns trigger
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

  -- Edits void every review/approval/publication applied to the older content.
  base := case when changed and not (old.state = any (planning)) then 'drafting' else old.state end;
  ok := new.state = base
    or article_transition_allowed(base, new.state)
    -- "review request" is decided at once: qa_pending → approval_pending | needs_revision
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

create trigger articles_rules before insert or update on articles
  for each row execute function enforce_article_rules();
