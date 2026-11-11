-- RLS acceptance test. Run against a plain Postgres: stubs Supabase's auth schema.
-- Usage: see supabase/tests/run.ps1. Any failed assertion raises and aborts (ON_ERROR_STOP).

create schema auth;
create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
-- Real Supabase derives this from the JWT; the stub reads the caller's row.
create function auth.jwt() returns jsonb language sql stable security definer as
  $$ select jsonb_build_object('email', (select email from auth.users where id = auth.uid())) $$;
create role authenticated nologin;
create role anon nologin;
grant usage on schema public, auth to authenticated, anon;

\ir ../migrations/0001_core_tenancy.sql
\ir ../migrations/0002_article_content_and_state_rules.sql
\ir ../migrations/0003_keywords.sql
\ir ../migrations/0004_team_and_roles.sql
\ir ../migrations/0005_keyword_link_and_revenue.sql
\ir ../migrations/0006_rate_limits.sql
\ir ../migrations/0007_agent_runs.sql
\ir ../migrations/0008_state_events_and_delivery_attempts.sql
\ir ../migrations/0009_published_url.sql
\ir ../migrations/0010_display_profiles_and_approval_hash.sql
\ir ../migrations/0011_site_checks.sql
\ir ../migrations/0012_costs_improvements_revenue_period.sql
\ir ../migrations/0013_brief_review_title_template.sql
\ir ../migrations/0014_brief_before_review_keyword_guard.sql
\ir ../migrations/0015_blog_accounts.sql
\ir ../migrations/0016_keyword_trends.sql
\ir ../migrations/0017_blog_metric_snapshots.sql
\ir ../migrations/0018_review_fixes.sql

-- Test fixture only: most articles below are about other rules and need a filled brief to reach review.
-- The brief tests set these columns to '' explicitly.
alter table articles alter column brief_purpose set default '목적', alter column brief_audience set default '대상';

grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage on all sequences in schema public to authenticated;

insert into auth.users values
  ('00000000-0000-0000-0000-0000000000a1', 'owner-a@example.com', now()), -- ownerA
  ('00000000-0000-0000-0000-0000000000a2', 'editor-a@example.com', now()), -- editorA
  ('00000000-0000-0000-0000-0000000000a3', 'viewer-a@example.com', now()), -- viewerA
  ('00000000-0000-0000-0000-0000000000a4', 'reviewer-a@example.com', now()), -- reviewerA
  ('00000000-0000-0000-0000-0000000000b1', 'owner-b@example.com', now()), -- ownerB
  ('00000000-0000-0000-0000-0000000000c1', 'newbie@example.com', now()), -- confirmed invitee
  ('00000000-0000-0000-0000-0000000000c2', 'unconfirmed@example.com', null), -- never confirmed
  ('00000000-0000-0000-0000-0000000000c3', 'adminc@example.com', now()); -- admin

create function as_user(u text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u, false);
  execute 'set role authenticated';
end $$;

create function expect_fail(stmt text, label text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    raise notice 'PASS (blocked): %', label;
    return;
  end;
  raise exception 'FAIL (was allowed): %', label;
end $$;

create function expect_count(stmt text, want int, label text) returns void language plpgsql as $$
declare got int;
begin
  execute stmt into got;
  if got <> want then raise exception 'FAIL: % (got %, want %)', label, got, want; end if;
  raise notice 'PASS: %', label;
end $$;

grant execute on function as_user(text), expect_fail(text, text), expect_count(text, int, text) to authenticated;

-- ---- setup as owners ----
select as_user('00000000-0000-0000-0000-0000000000a1');
insert into workspaces (id, name, owner_id) values
  ('10000000-0000-0000-0000-00000000000a', 'A', '00000000-0000-0000-0000-0000000000a1');
-- Clients can not write memberships any more (even the owner); the fixture uses the superuser.
select expect_fail($$insert into memberships values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', 'editor')$$,
  'owner can not insert memberships directly');
reset role;
insert into memberships values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', 'editor'),
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3', 'viewer'),
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a4', 'reviewer');
select as_user('00000000-0000-0000-0000-0000000000a1');
insert into blogs (id, workspace_id, platform, domain) values
  ('20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'wordpress', 'a.example');

select as_user('00000000-0000-0000-0000-0000000000b1');
insert into workspaces (id, name, owner_id) values
  ('10000000-0000-0000-0000-00000000000b', 'B', '00000000-0000-0000-0000-0000000000b1');
insert into blogs (id, workspace_id, platform, domain) values
  ('20000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'blogger', 'b.example');

-- ---- editor of A creates content ----
select as_user('00000000-0000-0000-0000-0000000000a2');
insert into articles (id, workspace_id, owner_id) values
  ('30000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2');
insert into article_versions (id, workspace_id, article_id, version, title, markdown, content_hash, created_by) values
  ('40000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a',
   '30000000-0000-0000-0000-00000000000a', 1, 't', 'body', 'h1', '00000000-0000-0000-0000-0000000000a2');

-- ---- tenant isolation ----
select expect_count('select count(*) from articles', 1, 'editorA sees own article');
select expect_count($$select count(*) from workspaces where id = '10000000-0000-0000-0000-00000000000b'$$, 0, 'editorA cannot see workspace B');
select expect_count($$select count(*) from blogs where workspace_id = '10000000-0000-0000-0000-00000000000b'$$, 0, 'editorA cannot see blogs of B');
select expect_fail($$insert into articles (workspace_id, owner_id)
  values ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000a2')$$,
  'editorA cannot insert article into workspace B');
-- cross-workspace FK: article in A pointing to blog of B
select expect_fail($$insert into articles (workspace_id, owner_id, blog_id)
  values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2',
          '20000000-0000-0000-0000-00000000000b')$$,
  'article in A cannot reference blog in B (composite FK)');
-- RLS hides the row from UPDATE (0 rows, no error), so assert the role is unchanged.
update memberships set role = 'owner' where user_id = '00000000-0000-0000-0000-0000000000a2';
select expect_count($$select count(*) from memberships
  where user_id = '00000000-0000-0000-0000-0000000000a2' and role = 'editor'$$, 1, 'editor cannot escalate own role');
select expect_fail($$insert into memberships values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000b1', 'owner')$$,
  'editor cannot add members');

select as_user('00000000-0000-0000-0000-0000000000b1');
select expect_count($$select count(*) from articles$$, 0, 'ownerB sees no articles of A');

-- ---- role limits ----
select as_user('00000000-0000-0000-0000-0000000000a3');
select expect_count('select count(*) from articles', 1, 'viewerA can read');
select expect_fail($$insert into articles (workspace_id, owner_id)
  values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3')$$,
  'viewer cannot create article');
select expect_fail($$insert into approvals (workspace_id, article_version_id, reviewer_id, decision, snapshot_hash)
  values ('10000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-00000000000a',
          '00000000-0000-0000-0000-0000000000a3', 'approved', 'h1')$$, 'viewer cannot approve');

select as_user('00000000-0000-0000-0000-0000000000a2');
select expect_fail($$insert into approvals (workspace_id, article_version_id, reviewer_id, decision, snapshot_hash)
  values ('10000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-00000000000a',
          '00000000-0000-0000-0000-0000000000a2', 'approved', 'h1')$$, 'editor cannot self-approve');
select expect_fail($$insert into blogs (workspace_id, platform, domain)
  values ('10000000-0000-0000-0000-00000000000a', 'naver', 'x.example')$$, 'editor cannot manage blogs');

select as_user('00000000-0000-0000-0000-0000000000a4');
insert into approvals (workspace_id, article_version_id, reviewer_id, decision, snapshot_hash)
  values ('10000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-00000000000a',
          '00000000-0000-0000-0000-0000000000a4', 'approved', 'h1');
select expect_fail($$insert into articles (workspace_id, owner_id)
  values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a4')$$,
  'reviewer cannot create article');
select expect_fail($$insert into approvals (workspace_id, article_version_id, reviewer_id, decision, snapshot_hash)
  values ('10000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-00000000000a',
          '00000000-0000-0000-0000-0000000000a1', 'approved', 'h1')$$, 'reviewer cannot approve as someone else');

-- ---- immutability ----
select as_user('00000000-0000-0000-0000-0000000000a1');
-- Regular users: no UPDATE/DELETE policy, so RLS hides rows and nothing changes.
update article_versions set markdown = 'tampered';
delete from approvals;
select expect_count($$select count(*) from article_versions where markdown = 'body'$$, 1, 'user cannot alter versions');
select expect_count($$select count(*) from approvals$$, 1, 'user cannot delete approvals');

-- Superuser / service_role bypasses RLS, so the triggers must still block.
reset role;
select expect_fail($$update article_versions set markdown = 'tampered'$$, 'versions immutable even for RLS bypass');
select expect_fail($$delete from approvals$$, 'approvals append-only even for RLS bypass');
insert into audit_logs (workspace_id, action) values ('10000000-0000-0000-0000-00000000000a', 'test');
select expect_fail($$delete from audit_logs$$, 'audit logs append-only even for RLS bypass');
-- ================= 0002: server-enforced lifecycle =================
-- Valid content for review: title, real body, http(s) source, no AI placeholders.
select as_user('00000000-0000-0000-0000-0000000000a1');
insert into articles (id, workspace_id, owner_id, state, title, body, source_url) values
  ('30000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-0000000000a1', 'drafting', 'T', E'## 해결\n본문 내용', 'https://example.com/x');

select expect_fail($$insert into articles (workspace_id, owner_id, state)
  values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'approved')$$,
  'new article can not start approved');
select expect_fail($$insert into articles (workspace_id, owner_id, remote)
  values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', '{"postId":1,"url":"x"}')$$,
  'new article can not carry remote info');
select expect_fail($$update articles set state = 'approved' where id = '30000000-0000-0000-0000-0000000000a2'$$,
  'drafting → approved directly is blocked');
select expect_fail($$update articles set state = 'published' where id = '30000000-0000-0000-0000-0000000000a2'$$,
  'drafting → published directly is blocked');
select expect_fail($$update articles set state = 'approval_pending', body = E'## 해결\n본문 [확인 필요]'
  where id = '30000000-0000-0000-0000-0000000000a2'$$, 'AI placeholder blocks review');
select expect_fail($$update articles set state = 'approval_pending', source_url = 'javascript:alert(1)'
  where id = '30000000-0000-0000-0000-0000000000a2'$$, 'unsafe source URL blocks review');
select expect_fail($$update articles set owner_id = '00000000-0000-0000-0000-0000000000a2'
  where id = '30000000-0000-0000-0000-0000000000a2'$$, 'owner can not be reassigned');

-- review request decided at once: drafting → approval_pending in one save
update articles set state = 'approval_pending' where id = '30000000-0000-0000-0000-0000000000a2';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-0000000000a2' and state = 'approval_pending'$$, 1, 'drafting → approval_pending');
select expect_count($$select count(*) from article_versions where article_id = '30000000-0000-0000-0000-0000000000a2'$$, 0, 'no snapshot before approval');
select expect_fail($$update articles set state = 'approved', body = 'changed after review'
  where id = '30000000-0000-0000-0000-0000000000a2'$$, 'editing and approving in one save is blocked');

update articles set state = 'approved', evidence_status = 'ok', rights_status = 'ok' where id = '30000000-0000-0000-0000-0000000000a2';
select expect_count($$select count(*) from article_versions where article_id = '30000000-0000-0000-0000-0000000000a2' and version = 1 and length(content_hash) = 64$$, 1, 'approval writes snapshot v1 with sha256');
select expect_count($$select count(*) from approvals a join article_versions v on v.id = a.article_version_id
  where v.article_id = '30000000-0000-0000-0000-0000000000a2' and a.snapshot_hash = v.content_hash$$, 1, 'approval row matches snapshot hash');
select expect_count($$select count(*) from audit_logs where action = 'article.approved'$$, 1, 'approval is audited');

-- editing approved content keeps it approved only if the state is reset
select expect_fail($$update articles set body = E'## 해결\n수정한 본문' where id = '30000000-0000-0000-0000-0000000000a2'$$,
  'content edit while staying approved is blocked');
update articles set body = E'## 해결\n수정한 본문', state = 'drafting' where id = '30000000-0000-0000-0000-0000000000a2';
select expect_count($$select count(*) from article_versions where article_id = '30000000-0000-0000-0000-0000000000a2'$$, 1, 'old snapshot is preserved');
update articles set state = 'approval_pending' where id = '30000000-0000-0000-0000-0000000000a2';
update articles set state = 'approved', evidence_status = 'ok', rights_status = 'ok' where id = '30000000-0000-0000-0000-0000000000a2';
select expect_count($$select count(*) from article_versions where article_id = '30000000-0000-0000-0000-0000000000a2' and version = 2$$, 1, 're-approval writes snapshot v2');

-- delivery chain
update articles set state = 'export_ready' where id = '30000000-0000-0000-0000-0000000000a2';
update articles set state = 'publishing' where id = '30000000-0000-0000-0000-0000000000a2';
select expect_fail($$update articles set state = 'published' where id = '30000000-0000-0000-0000-0000000000a2'$$,
  'publishing → published needs an operator confirmation step');
update articles set state = 'draft_created', remote = '{"postId":7,"url":"https://x/?p=7"}'
  where id = '30000000-0000-0000-0000-0000000000a2';
update articles set state = 'published', published_url = 'https://blog.example/a2' where id = '30000000-0000-0000-0000-0000000000a2';
-- editing published content resets it, remote info stays for the retry
update articles set title = 'T2', state = 'drafting' where id = '30000000-0000-0000-0000-0000000000a2';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-0000000000a2' and remote is not null$$, 1, 'remote draft info survives edits');
select expect_fail($$update articles set remote = '{"foo":1}' where id = '30000000-0000-0000-0000-0000000000a2'$$, 'malformed remote rejected');

-- an editor can drive an article to approval_pending but can not approve it
select as_user('00000000-0000-0000-0000-0000000000a2');
insert into articles (id, workspace_id, owner_id, state, title, body, source_url) values
  ('30000000-0000-0000-0000-0000000000a3', '10000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-0000000000a2', 'drafting', 'T', E'## 해결\n본문 내용', 'https://example.com/x');
update articles set state = 'approval_pending' where id = '30000000-0000-0000-0000-0000000000a3';
select expect_fail($$update articles set state = 'approved' where id = '30000000-0000-0000-0000-0000000000a3'$$,
  'editor can not approve (reviewer/admin/owner only)');

-- a reviewer can approve but never create or edit content
select as_user('00000000-0000-0000-0000-0000000000a4');
select expect_fail($$update articles set title = 'x' where id = '30000000-0000-0000-0000-0000000000a3'$$, 'reviewer can not edit content');
select expect_fail($$update articles set state = 'drafting' where id = '30000000-0000-0000-0000-0000000000a3'$$, 'reviewer can not move an article anywhere but approve/send back');
-- ...but can approve an article that waits for approval (editor created it above)
update articles set state = 'approved', evidence_status = 'ok', rights_status = 'ok' where id = '30000000-0000-0000-0000-0000000000a3';
select expect_count($$select count(*) from approvals where reviewer_id = '00000000-0000-0000-0000-0000000000a4'$$, 2, 'reviewer approval is recorded under the reviewer');
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-0000000000a3' and state = 'approved'$$, 1, 'reviewer approved an editor article');

-- ================= 0003: keywords =================
select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
insert into keywords (workspace_id, phrase, created_by) values
  ('10000000-0000-0000-0000-00000000000a', 'Next.js  포트 오류', '00000000-0000-0000-0000-0000000000a2');
select expect_fail($$insert into keywords (workspace_id, phrase, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'ｎｅｘｔ.js 포트 오류', '00000000-0000-0000-0000-0000000000a2')$$,
  'duplicate keyword (case, spacing, full-width) is rejected by the database');
select expect_fail($$insert into keywords (workspace_id, phrase, priority, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'x', 9, '00000000-0000-0000-0000-0000000000a2')$$, 'priority outside 1..5 rejected');
select expect_fail($$insert into keywords (workspace_id, phrase, created_by)
  values ('10000000-0000-0000-0000-00000000000a', '   ', '00000000-0000-0000-0000-0000000000a2')$$, 'blank phrase rejected');
select expect_fail($$insert into keywords (workspace_id, phrase, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'y', '00000000-0000-0000-0000-0000000000a1')$$, 'created_by must be the caller');
select expect_fail($$insert into keywords (workspace_id, phrase, created_by)
  values ('10000000-0000-0000-0000-00000000000b', 'z', '00000000-0000-0000-0000-0000000000a2')$$, 'editorA cannot write keywords into workspace B');
-- same phrase in a different workspace is allowed
select as_user('00000000-0000-0000-0000-0000000000b1');
insert into keywords (workspace_id, phrase, created_by) values
  ('10000000-0000-0000-0000-00000000000b', 'next.js 포트 오류', '00000000-0000-0000-0000-0000000000b1');
select expect_count($$select count(*) from keywords$$, 1, 'ownerB sees only its own keyword');
select as_user('00000000-0000-0000-0000-0000000000a3'); -- viewerA
select expect_count($$select count(*) from keywords$$, 1, 'viewerA can read A keywords');
select expect_fail($$insert into keywords (workspace_id, phrase, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'v', '00000000-0000-0000-0000-0000000000a3')$$, 'viewer cannot add keywords');
delete from keywords;
select expect_count($$select count(*) from keywords$$, 1, 'viewer cannot delete keywords');
select as_user('00000000-0000-0000-0000-0000000000a2');
delete from keywords;
select expect_count($$select count(*) from keywords$$, 0, 'editor can delete keywords');
-- cap
reset role;
insert into keywords (workspace_id, phrase, created_by)
  select '10000000-0000-0000-0000-00000000000a', 'bulk ' || g, '00000000-0000-0000-0000-0000000000a2' from generate_series(1, 5000) g;
select expect_fail($$insert into keywords (workspace_id, phrase, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'one too many', '00000000-0000-0000-0000-0000000000a2')$$, '5000 keyword cap enforced by the database');
delete from keywords;
-- ================= 0004: team =================
reset role;
select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
select expect_fail($$select invite_member('10000000-0000-0000-0000-00000000000a', 'x@example.com', 'viewer')$$, 'editor can not invite');
select as_user('00000000-0000-0000-0000-0000000000a1'); -- ownerA
select expect_fail($$select invite_member('10000000-0000-0000-0000-00000000000a', 'x@example.com', 'owner')$$, 'owner role can not be invited');
select expect_fail($$select invite_member('10000000-0000-0000-0000-00000000000a', 'not-an-email', 'viewer')$$, 'invalid email rejected');
select expect_fail($$select invite_member('10000000-0000-0000-0000-00000000000a', 'EDITOR-A@example.com', 'viewer')$$, 'existing member (any case) can not be invited');
select expect_fail($$select invite_member('10000000-0000-0000-0000-00000000000b', 'x@example.com', 'viewer')$$, 'owner of A can not invite into workspace B');
select invite_member('10000000-0000-0000-0000-00000000000a', ' Newbie@Example.com ', 'editor');
select invite_member('10000000-0000-0000-0000-00000000000a', 'unconfirmed@example.com', 'viewer');
select invite_member('10000000-0000-0000-0000-00000000000a', 'adminc@example.com', 'admin');
select expect_count($$select count(*) from invitations where workspace_id = '10000000-0000-0000-0000-00000000000a'$$, 3, 'owner sees the invitations');
-- re-inviting the same email updates the single record
select invite_member('10000000-0000-0000-0000-00000000000a', 'newbie@example.com', 'reviewer');
select expect_count($$select count(*) from invitations where email_key = 'newbie@example.com' and role = 'reviewer'$$, 1, 're-invite updates instead of duplicating');
select expect_count($$select count(*) from audit_logs where action = 'member.invited'$$, 4, 'invitations are audited');

-- the invitee
select as_user('00000000-0000-0000-0000-0000000000c1'); -- newbie
select expect_count($$select count(*) from invitations$$, 1, 'invitee sees only the invitation for their own email');
select expect_count($$select count(*) from my_invitations()$$, 1, 'my_invitations lists it with the workspace name');
select expect_count($$select count(*) from workspaces$$, 0, 'invitee can not read the workspace before joining');
select expect_count($$select count(*) from articles$$, 0, 'invitee can not read articles before joining');
select expect_fail($$select accept_invitation((select id from invitations limit 1)::uuid) where false$$ || ' union all select accept_invitation(gen_random_uuid())', 'unknown invitation can not be accepted');
select as_user('00000000-0000-0000-0000-0000000000c2'); -- unconfirmed email
select expect_count($$select count(*) from my_invitations()$$, 0, 'unconfirmed email sees no invitations');
reset role;
select as_user('00000000-0000-0000-0000-0000000000b1'); -- another user can not accept or revoke it
select expect_fail($$select accept_invitation((select id from (select id from invitations) x limit 1))$$, 'foreign user can not accept someone else''s invitation (not visible)');
select as_user('00000000-0000-0000-0000-0000000000c1');
select accept_invitation(id) from invitations where email_key = 'newbie@example.com';
select expect_count($$select count(*) from memberships where user_id = '00000000-0000-0000-0000-0000000000c1' and role = 'reviewer'$$, 1, 'invitee joined with the invited role');
select expect_count($$select count(*) from articles$$, 3, 'new member now reads the workspace');
select expect_fail($$select accept_invitation(id) from invitations where email_key = 'newbie@example.com'$$, 'an invitation can be accepted only once');
select as_user('00000000-0000-0000-0000-0000000000c2');
select expect_fail($$select accept_invitation(id) from invitations where email_key = 'unconfirmed@example.com'$$, 'unconfirmed email can not accept');

-- members and roles
select as_user('00000000-0000-0000-0000-0000000000a3'); -- viewerA reads the member list
select expect_count($$select count(*) from workspace_members('10000000-0000-0000-0000-00000000000a')$$, 5, 'a viewer can list members');
select expect_count($$select count(*) from workspace_members('10000000-0000-0000-0000-00000000000b')$$, 0, 'members of another workspace are not listed');
select expect_fail($$select change_member_role('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3', 'owner')$$, 'viewer can not change roles');
select as_user('00000000-0000-0000-0000-0000000000a1');
select expect_fail($$select change_member_role('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3', 'owner')$$, 'nobody can be promoted to owner');
select expect_fail($$select change_member_role('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'viewer')$$, 'the owner can not be demoted');
select expect_fail($$select remove_member('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1')$$, 'the owner can not be removed');
select change_member_role('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3', 'editor');
select expect_count($$select count(*) from memberships where user_id = '00000000-0000-0000-0000-0000000000a3' and role = 'editor'$$, 1, 'owner changes a role');
select change_member_role('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3', 'viewer');
-- an admin: can manage below admin only
reset role;
insert into memberships values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c3', 'admin');
select as_user('00000000-0000-0000-0000-0000000000c3'); -- admin
select expect_fail($$select invite_member('10000000-0000-0000-0000-00000000000a', 'y@example.com', 'admin')$$, 'admin can not invite admins');
select invite_member('10000000-0000-0000-0000-00000000000a', 'y@example.com', 'viewer');
select expect_fail($$select change_member_role('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'viewer')$$, 'admin can not touch the owner');
select expect_fail($$select change_member_role('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3', 'admin')$$, 'admin can not create admins');
select expect_fail($$insert into memberships values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000b1', 'owner')$$, 'admin can not insert an owner membership directly');
select change_member_role('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3', 'editor');
select remove_member('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3');
select expect_count($$select count(*) from memberships where user_id = '00000000-0000-0000-0000-0000000000a3'$$, 0, 'admin removes a viewer/editor');
select delete_invitation(id) from invitations where email_key = 'y@example.com';
select expect_count($$select count(*) from invitations where email_key = 'y@example.com'$$, 0, 'admin revokes an invitation');
-- removed user loses access at once
select as_user('00000000-0000-0000-0000-0000000000a3');
select expect_count($$select count(*) from articles$$, 0, 'removed member can no longer read articles');
-- leaving a workspace
select as_user('00000000-0000-0000-0000-0000000000c1'); -- reviewer who joined
select remove_member('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1');
select expect_count($$select count(*) from memberships where user_id = '00000000-0000-0000-0000-0000000000c1'$$, 0, 'a member can leave');
select as_user('00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from audit_logs where action in ('member.joined','member.role_changed','member.removed')$$, 6, 'membership changes are audited');
-- the invitee can decline
select invite_member('10000000-0000-0000-0000-00000000000a', 'newbie@example.com', 'viewer');
select as_user('00000000-0000-0000-0000-0000000000c1');
select delete_invitation(id) from invitations where email_key = 'newbie@example.com';
select expect_count($$select count(*) from invitations$$, 0, 'invitee can decline');
reset role;
-- ================= 0005: keyword link + revenue =================
select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
insert into keywords (id, workspace_id, phrase, created_by) values
  ('50000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'link me', '00000000-0000-0000-0000-0000000000a2');
select as_user('00000000-0000-0000-0000-0000000000b1');
insert into keywords (id, workspace_id, phrase, created_by) values
  ('50000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'link me', '00000000-0000-0000-0000-0000000000b1');
select as_user('00000000-0000-0000-0000-0000000000a2');
insert into articles (id, workspace_id, owner_id, keyword_id) values
  ('30000000-0000-0000-0000-0000000000a9', '10000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-0000000000a2', '50000000-0000-0000-0000-00000000000a');
select expect_fail($$insert into articles (workspace_id, owner_id, keyword_id)
  values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', '50000000-0000-0000-0000-00000000000b')$$,
  'an article can not link to a keyword of another workspace');
-- changing only the link is not a content edit: an approved article stays approved
update articles set keyword_id = '50000000-0000-0000-0000-00000000000a' where id = '30000000-0000-0000-0000-0000000000a3';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-0000000000a3' and state = 'approved' and keyword_id is not null$$, 1, 'linking a keyword is not a content edit: an approved article stays approved');
select expect_count($$select count(*) from article_versions where article_id = '30000000-0000-0000-0000-0000000000a3'$$, 1, 'linking does not create a new approval snapshot');
delete from keywords where id = '50000000-0000-0000-0000-00000000000a';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-0000000000a9' and keyword_id is null$$, 1, 'deleting a keyword keeps the article and clears the link');
delete from articles where id = '30000000-0000-0000-0000-0000000000a9';

-- revenue
select as_user('00000000-0000-0000-0000-0000000000a1'); -- ownerA
insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, timezone, period_start, period_end, page, revenue, pageviews, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'adsense|estimated|KRW|2026-11-01|', 'AdSense', 'estimated', 'KRW', '2026-11-01', 'Asia/Seoul', '2026-11-01', '2026-11-01', '', 1000.5, 500, '00000000-0000-0000-0000-0000000000a1');
select expect_fail($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, timezone, period_start, period_end, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'adsense|estimated|KRW|2026-11-01|', 'AdSense', 'estimated', 'KRW', '2026-11-01', 'Asia/Seoul', '2026-11-01', '2026-11-01', 5, '00000000-0000-0000-0000-0000000000a1')$$,
  'the same report row can not be stored twice');
select expect_fail($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, timezone, period_start, period_end, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'k2', 'AdSense', 'estimated', 'KRW', '2026-11-01', 'Asia/Seoul', '2026-11-01', '2026-11-01', -1, '00000000-0000-0000-0000-0000000000a1')$$, 'negative revenue rejected');
select expect_fail($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, timezone, period_start, period_end, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'k3', 'AdSense', 'maybe', 'KRW', '2026-11-01', 'Asia/Seoul', '2026-11-01', '2026-11-01', 1, '00000000-0000-0000-0000-0000000000a1')$$, 'unknown status rejected');
select expect_fail($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, timezone, period_start, period_end, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'k4', 'AdSense', 'estimated', 'won', '2026-11-01', 'Asia/Seoul', '2026-11-01', '2026-11-01', 1, '00000000-0000-0000-0000-0000000000a1')$$, 'bad currency rejected');
select expect_fail($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, timezone, period_start, period_end, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'k5', 'AdSense', 'estimated', 'KRW', '2026-11-01', 'Asia/Seoul', '2026-11-01', '2026-11-01', '00000000-0000-0000-0000-0000000000a1')$$, 'a row with no values at all is rejected');
select expect_fail($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, timezone, period_start, period_end, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000b', 'k6', 'AdSense', 'estimated', 'KRW', '2026-11-01', 'Asia/Seoul', '2026-11-01', '2026-11-01', 1, '00000000-0000-0000-0000-0000000000a1')$$, 'ownerA can not write revenue into workspace B');
select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
select expect_count($$select count(*) from revenue_rows$$, 1, 'members can read revenue');
select expect_fail($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, timezone, period_start, period_end, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'k7', 'AdSense', 'estimated', 'KRW', '2026-11-01', 'Asia/Seoul', '2026-11-01', '2026-11-01', 1, '00000000-0000-0000-0000-0000000000a2')$$, 'editor can not import revenue (owner/admin only)');
delete from revenue_rows;
select expect_count($$select count(*) from revenue_rows$$, 1, 'editor can not delete revenue');
select as_user('00000000-0000-0000-0000-0000000000b1');
select expect_count($$select count(*) from revenue_rows$$, 0, 'workspace B sees no revenue of A');
reset role;
insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, timezone, period_start, period_end, revenue, created_by)
  select '10000000-0000-0000-0000-00000000000a', 'bulk' || g, 'S', 'estimated', 'KRW', '2026-11-01', 'Asia/Seoul', '2026-11-01', '2026-11-01', 1, '00000000-0000-0000-0000-0000000000a1' from generate_series(1, 19999) g;
select expect_fail($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, timezone, period_start, period_end, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'over', 'S', 'estimated', 'KRW', '2026-11-01', 'Asia/Seoul', '2026-11-01', '2026-11-01', 1, '00000000-0000-0000-0000-0000000000a1')$$, '20000 revenue row cap enforced by the database');
delete from revenue_rows;

-- ================= 0006: rate limits =================
set role anon;
select expect_count($$select count(*) from (select rate_limit_hit('t:1', 3, 60) l union all select rate_limit_hit('t:1', 3, 60) union all select rate_limit_hit('t:1', 3, 60)) x where not l$$, 3, 'first 3 hits are allowed (anon can call it)');
select expect_count($$select case when rate_limit_hit('t:1', 3, 60) then 1 else 0 end$$, 1, 'the 4th hit in the window is limited');
select expect_count($$select case when rate_limit_hit('t:2', 3, 60) then 1 else 0 end$$, 0, 'other keys are independent');
select expect_fail($$select rate_limit_hit('x', 0, 60)$$, 'invalid max rejected');
select expect_fail($$select rate_limit_hit('x', 1, 999999)$$, 'invalid window rejected');
select expect_fail($$select rate_limit_hit(repeat('k', 201), 1, 60)$$, 'overlong key rejected');
select expect_fail($$select * from rate_limits$$, 'clients can not read the limiter table');
reset role;
update rate_limits set window_start = now() - interval '2 minutes' where key = 't:1';
set role anon;
select expect_count($$select case when rate_limit_hit('t:1', 3, 60) then 1 else 0 end$$, 0, 'the window resets after it elapsed');
reset role;
-- ================= 0007: agent runs =================
reset role;
-- viewerA was removed by the team tests above.
insert into memberships values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3', 'viewer');
create function run_values(ws text, actor text) returns text language sql immutable as
  $f$ select format($v$('%s', 'draft', 'm', 'draft-v1', 'succeeded', 10, 20, 1500, 0.001, 'USD', '%s')$v$, ws, actor) $f$;
grant execute on function run_values(text, text) to authenticated;
select as_user('00000000-0000-0000-0000-0000000000a1'); -- owner
insert into agent_runs (workspace_id, task, model, prompt_version, status, tokens_in, tokens_out, duration_ms, cost_estimate, cost_currency, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'draft', 'm', 'draft-v1', 'succeeded', 10, 20, 1500, 0.001, 'USD', '00000000-0000-0000-0000-0000000000a1');
select as_user('00000000-0000-0000-0000-0000000000c3'); -- admin
insert into agent_runs (workspace_id, task, model, prompt_version, status, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'draft', 'm', 'draft-v1', 'timeout', 60000, '00000000-0000-0000-0000-0000000000c3');
select as_user('00000000-0000-0000-0000-0000000000a4'); -- reviewer
insert into agent_runs (workspace_id, task, model, prompt_version, status, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'review', 'm', 'review-v1', 'failed', 20, '00000000-0000-0000-0000-0000000000a4');
select as_user('00000000-0000-0000-0000-0000000000a2'); -- editor
insert into agent_runs (workspace_id, task, model, prompt_version, status, tokens_in, tokens_out, duration_ms, cost_estimate, cost_currency, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'draft', 'm', 'draft-v1', 'succeeded', 1, 2, 30, 0.5, 'KRW', '00000000-0000-0000-0000-0000000000a2');
select expect_count($$select count(*) from agent_runs where tokens_in is null and cost_estimate is null$$, 2, 'runs without usage keep NULL tokens and cost');
select expect_fail($$insert into agent_runs (workspace_id, task, model, prompt_version, status, tokens_in, tokens_out, duration_ms, cost_estimate, cost_currency, created_by)
  values $$ || run_values('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000a2'), 'editorA can not write runs into workspace B');
select expect_fail($$insert into agent_runs (workspace_id, task, model, prompt_version, status, tokens_in, tokens_out, duration_ms, cost_estimate, cost_currency, created_by)
  values $$ || run_values('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1'), 'created_by must be the caller');
select expect_fail($$insert into agent_runs (workspace_id, task, model, prompt_version, status, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'draft', 'm', 'v', 'maybe', 1, '00000000-0000-0000-0000-0000000000a2')$$, 'unknown run status rejected');
select expect_fail($$insert into agent_runs (workspace_id, task, model, prompt_version, status, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'publish', 'm', 'v', 'failed', 1, '00000000-0000-0000-0000-0000000000a2')$$, 'unknown run task rejected');
select expect_fail($$insert into agent_runs (workspace_id, task, model, prompt_version, status, tokens_in, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'draft', 'm', 'v', 'failed', -1, 1, '00000000-0000-0000-0000-0000000000a2')$$, 'negative tokens rejected');
select expect_fail($$insert into agent_runs (workspace_id, task, model, prompt_version, status, tokens_in, tokens_out, duration_ms, cost_estimate, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'draft', 'm', 'v', 'succeeded', 1, 1, 1, 0.1, '00000000-0000-0000-0000-0000000000a2')$$, 'a cost needs a currency');
select expect_fail($$insert into agent_runs (workspace_id, task, model, prompt_version, status, duration_ms, cost_estimate, cost_currency, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'draft', 'm', 'v', 'succeeded', 1, 0, 'USD', '00000000-0000-0000-0000-0000000000a2')$$, 'no usage can not carry a cost (not even 0)');
select as_user('00000000-0000-0000-0000-0000000000a3'); -- viewerA
select expect_count($$select count(*) from agent_runs$$, 4, 'viewer can read the runs of the workspace');
select expect_fail($$insert into agent_runs (workspace_id, task, model, prompt_version, status, tokens_in, tokens_out, duration_ms, cost_estimate, cost_currency, created_by)
  values $$ || run_values('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3'), 'viewer can not write runs');
select as_user('00000000-0000-0000-0000-0000000000c1'); -- left the workspace above
select expect_count($$select count(*) from agent_runs$$, 0, 'non-member reads no runs');
select expect_fail($$insert into agent_runs (workspace_id, task, model, prompt_version, status, tokens_in, tokens_out, duration_ms, cost_estimate, cost_currency, created_by)
  values $$ || run_values('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1'), 'non-member can not write runs');
select as_user('00000000-0000-0000-0000-0000000000b1');
select expect_count($$select count(*) from agent_runs$$, 0, 'workspace B sees no runs of A');
select as_user('00000000-0000-0000-0000-0000000000a1');
update agent_runs set status = 'succeeded', model = 'tampered';
delete from agent_runs;
select expect_count($$select count(*) from agent_runs where model = 'm'$$, 4, 'even the owner can not change or delete runs');
reset role;
-- ================= 0008: state events + delivery attempts =================
select as_user('00000000-0000-0000-0000-0000000000a1'); -- ownerA
insert into articles (id, workspace_id, owner_id, state, title, body, source_url) values
  ('30000000-0000-0000-0000-0000000000a8', '10000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-0000000000a1', 'drafting', 'T', E'## 해결\n본문 내용', 'https://example.com/x'),
  ('30000000-0000-0000-0000-0000000000a7', '10000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-0000000000a1', 'drafting', 'T', E'## 해결\n본문 내용', 'https://example.com/x');
select expect_count($$select count(*) from article_state_events where article_id = '30000000-0000-0000-0000-0000000000a8'$$, 0, 'creating an article is not a transition');
update articles set title = 'T edited' where id = '30000000-0000-0000-0000-0000000000a8';
select expect_count($$select count(*) from article_state_events where article_id = '30000000-0000-0000-0000-0000000000a8'$$, 0, 'a save without a state change records nothing');
select expect_fail($$update articles set state = 'published' where id = '30000000-0000-0000-0000-0000000000a8'$$, 'illegal transition stays blocked');
select expect_count($$select count(*) from article_state_events where article_id = '30000000-0000-0000-0000-0000000000a8'$$, 0, 'a rejected transition records nothing');
update articles set state = 'approval_pending' where id = '30000000-0000-0000-0000-0000000000a8';
update articles set state = 'approved', evidence_status = 'ok', rights_status = 'ok' where id = '30000000-0000-0000-0000-0000000000a8';
update articles set state = 'export_ready' where id = '30000000-0000-0000-0000-0000000000a8';
select expect_count($$select count(*) from delivery_attempts$$, 0, 'no delivery is logged before a hand-off');
update articles set state = 'manual_pending' where id = '30000000-0000-0000-0000-0000000000a8';
select expect_count($$select count(*) from article_state_events where article_id = '30000000-0000-0000-0000-0000000000a8' and actor_id = '00000000-0000-0000-0000-0000000000a1'$$, 4, 'each transition is recorded with its actor');
select expect_count($$select count(*) from article_state_events where article_id = '30000000-0000-0000-0000-0000000000a8' and from_state = 'drafting' and to_state = 'approval_pending'$$, 1, 'event stores the stored transition');
select expect_count($$select count(*) from delivery_attempts where channel = 'manual' and attempt = 1 and failure_type is null and url is null and duration_ms is null and created_by = '00000000-0000-0000-0000-0000000000a1'$$, 1, 'manual_pending records a manual hand-off');
update articles set state = 'export_ready' where id = '30000000-0000-0000-0000-0000000000a8';
update articles set state = 'manual_pending' where id = '30000000-0000-0000-0000-0000000000a8';
select expect_count($$select count(*) from delivery_attempts where channel = 'manual' and attempt = 2$$, 1, 'a second hand-off is attempt 2');

-- clients can not write state events, whatever their role
select expect_fail($$insert into article_state_events (workspace_id, article_id, from_state, to_state, actor_id)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a8', 'idea', 'approved', '00000000-0000-0000-0000-0000000000a1')$$, 'the owner can not insert state events');
update article_state_events set to_state = 'published';
delete from article_state_events;
select expect_count($$select count(*) from article_state_events where article_id = '30000000-0000-0000-0000-0000000000a8' and to_state = 'published'$$, 0, 'the owner can not change state events');
select expect_count($$select count(*) from article_state_events where article_id = '30000000-0000-0000-0000-0000000000a8'$$, 6, 'the owner can not delete state events');
select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
select expect_fail($$insert into article_state_events (workspace_id, article_id, from_state, to_state, actor_id)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a8', 'idea', 'approved', '00000000-0000-0000-0000-0000000000a2')$$, 'an editor can not insert state events');

-- WordPress attempts: editors and above, always numbered by the database
insert into delivery_attempts (workspace_id, article_id, channel, attempt, failure_type, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a8', 'wordpress', 99, 'timeout', 15000, '00000000-0000-0000-0000-0000000000a2');
insert into delivery_attempts (workspace_id, article_id, channel, url, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a8', 'wordpress', 'https://blog.example/?p=7', 800, '00000000-0000-0000-0000-0000000000a2');
select expect_count($$select count(*) from delivery_attempts where channel = 'wordpress' and attempt = 1 and failure_type = 'timeout'$$, 1, 'a client-chosen attempt number is replaced');
select expect_count($$select count(*) from delivery_attempts where channel = 'wordpress' and attempt = 2 and url is not null$$, 1, 'attempts are numbered per article and channel');
select expect_fail($$insert into delivery_attempts (workspace_id, article_id, channel, created_by)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a8', 'manual', '00000000-0000-0000-0000-0000000000a2')$$, 'clients can not forge a manual hand-off');
select expect_fail($$insert into delivery_attempts (workspace_id, article_id, channel, failure_type, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a8', 'wordpress', 'timeout', 1, '00000000-0000-0000-0000-0000000000a1')$$, 'created_by must be the caller');
select expect_fail($$insert into delivery_attempts (workspace_id, article_id, channel, failure_type, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a8', 'wordpress', 'maybe', 1, '00000000-0000-0000-0000-0000000000a2')$$, 'unknown failure type rejected');
select expect_fail($$insert into delivery_attempts (workspace_id, article_id, channel, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a8', 'wordpress', 1, '00000000-0000-0000-0000-0000000000a2')$$, 'a success needs a URL');
select expect_fail($$insert into delivery_attempts (workspace_id, article_id, channel, failure_type, url, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a8', 'wordpress', 'server', 'https://x', 1, '00000000-0000-0000-0000-0000000000a2')$$, 'a failure has no URL');
select expect_fail($$insert into delivery_attempts (workspace_id, article_id, channel, url, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a8', 'wordpress', 'javascript:alert(1)', 1, '00000000-0000-0000-0000-0000000000a2')$$, 'unsafe URL rejected');
select expect_fail($$insert into delivery_attempts (workspace_id, article_id, channel, failure_type, created_by)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a8', 'wordpress', 'server', '00000000-0000-0000-0000-0000000000a2')$$, 'a WordPress attempt needs a duration');

-- cross-workspace
select as_user('00000000-0000-0000-0000-0000000000b1'); -- ownerB
insert into articles (id, workspace_id, owner_id) values
  ('30000000-0000-0000-0000-0000000000b8', '10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1');
select expect_count($$select count(*) from article_state_events$$, 0, 'workspace B sees no state events of A');
select expect_count($$select count(*) from delivery_attempts$$, 0, 'workspace B sees no delivery attempts of A');
select expect_fail($$insert into delivery_attempts (workspace_id, article_id, channel, failure_type, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a8', 'wordpress', 'server', 1, '00000000-0000-0000-0000-0000000000b1')$$, 'ownerB can not log attempts in workspace A');
select expect_fail($$insert into delivery_attempts (workspace_id, article_id, channel, failure_type, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000b', '30000000-0000-0000-0000-0000000000a8', 'wordpress', 'server', 1, '00000000-0000-0000-0000-0000000000b1')$$, 'ownerB can not attach an attempt to an article of A (composite FK)');
select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
select expect_fail($$insert into delivery_attempts (workspace_id, article_id, channel, failure_type, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000b8', 'wordpress', 'server', 1, '00000000-0000-0000-0000-0000000000a2')$$, 'editorA can not attach an attempt to an article of B (composite FK)');
select expect_fail($$insert into delivery_attempts (workspace_id, article_id, channel, failure_type, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000b', '30000000-0000-0000-0000-0000000000b8', 'wordpress', 'server', 1, '00000000-0000-0000-0000-0000000000a2')$$, 'editorA can not write attempts into workspace B');
reset role;
select expect_fail($$insert into article_state_events (workspace_id, article_id, from_state, to_state)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000b8', 'idea', 'researching')$$, 'state events can not mix workspaces (composite FK)');

-- roles
select as_user('00000000-0000-0000-0000-0000000000a3'); -- viewerA
select expect_count($$select count(*) from article_state_events where article_id = '30000000-0000-0000-0000-0000000000a8'$$, 6, 'a viewer can read state events');
select expect_count($$select count(*) from delivery_attempts$$, 4, 'a viewer can read delivery attempts');
select expect_fail($$insert into delivery_attempts (workspace_id, article_id, channel, failure_type, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a8', 'wordpress', 'server', 1, '00000000-0000-0000-0000-0000000000a3')$$, 'a viewer can not log attempts');
select as_user('00000000-0000-0000-0000-0000000000a4'); -- reviewerA
select expect_fail($$insert into delivery_attempts (workspace_id, article_id, channel, failure_type, duration_ms, created_by)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a8', 'wordpress', 'server', 1, '00000000-0000-0000-0000-0000000000a4')$$, 'a reviewer can not log attempts');
select as_user('00000000-0000-0000-0000-0000000000c1'); -- not a member any more
select expect_count($$select count(*) from article_state_events$$, 0, 'a non-member reads no state events');
select expect_count($$select count(*) from delivery_attempts$$, 0, 'a non-member reads no attempts');
select as_user('00000000-0000-0000-0000-0000000000a1');
update delivery_attempts set failure_type = 'unknown', url = null;
delete from delivery_attempts;
select expect_count($$select count(*) from delivery_attempts where failure_type = 'unknown'$$, 0, 'even the owner can not change attempts');
select expect_count($$select count(*) from delivery_attempts$$, 4, 'even the owner can not delete attempts');

-- the log never makes an article undeletable
update articles set state = 'approval_pending' where id = '30000000-0000-0000-0000-0000000000a7';
update articles set state = 'needs_revision' where id = '30000000-0000-0000-0000-0000000000a7';
delete from articles where id = '30000000-0000-0000-0000-0000000000a7';
select expect_count($$select count(*) from article_state_events where article_id = '30000000-0000-0000-0000-0000000000a7'$$, 0, 'deleting an article removes its history');

-- ---- published_url (0009) ----
select expect_fail($$insert into articles (workspace_id, owner_id, published_url)
  values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'https://blog.example/p')$$, 'a new article has no public URL');
insert into articles (id, workspace_id, owner_id, state, title, body, source_url) values
  ('30000000-0000-0000-0000-0000000000d1', '10000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-0000000000a1', 'drafting', 'T', E'## 해결\n본문 내용', 'https://example.com/x'),
  ('30000000-0000-0000-0000-0000000000d2', '10000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-0000000000a1', 'drafting', 'T', E'## 해결\n본문 내용', 'https://example.com/x'),
  ('30000000-0000-0000-0000-0000000000d3', '10000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-0000000000a1', 'drafting', 'T', E'## 해결\n본문 내용', 'https://example.com/x');
select expect_fail($$update articles set published_url = 'https://blog.example/p' where id = '30000000-0000-0000-0000-0000000000d1'$$, 'the URL can not be set while drafting');
update articles set state = 'approval_pending' where id::text like '30000000-0000-0000-0000-0000000000d_';

-- reviewers: the guard itself must refuse, before the general URL rule is reached
select as_user('00000000-0000-0000-0000-0000000000a4'); -- reviewerA
do $$
begin
  update articles set state = 'approved', published_url = 'https://blog.example/p' where id = '30000000-0000-0000-0000-0000000000d1';
  raise exception 'FAIL (was allowed): reviewer set the public URL while approving';
exception when others then
  if sqlerrm not like 'reviewers can only%' then raise; end if;
  raise notice 'PASS (blocked): reviewer guard refuses a public URL change';
end $$;
select as_user('00000000-0000-0000-0000-0000000000a1');

update articles set state = 'approved', evidence_status = 'ok', rights_status = 'ok' where id::text like '30000000-0000-0000-0000-0000000000d_';
update articles set state = 'export_ready' where id::text like '30000000-0000-0000-0000-0000000000d_';
select expect_fail($$update articles set published_url = 'https://blog.example/p' where id = '30000000-0000-0000-0000-0000000000d1'$$, 'the URL can not be set before the publish transition');
update articles set state = 'manual_pending' where id::text like '30000000-0000-0000-0000-0000000000d_';
select expect_fail($$update articles set published_url = 'https://blog.example/p' where id = '30000000-0000-0000-0000-0000000000d1'$$, 'the URL can not be set without the publish transition');
select expect_fail($$update articles set state = 'published' where id = '30000000-0000-0000-0000-0000000000d1'$$, 'publishing needs a URL');
select expect_fail($$update articles set state = 'published', published_url = 'javascript:alert(1)' where id = '30000000-0000-0000-0000-0000000000d1'$$, 'publishing refuses a non-http URL');
select expect_fail($$update articles set state = 'published', published_url = 'https://blog.example/a b' where id = '30000000-0000-0000-0000-0000000000d1'$$, 'publishing refuses a URL with spaces');

update articles set state = 'published', published_url = 'https://blog.example/p' where id::text like '30000000-0000-0000-0000-0000000000d_';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-0000000000d1' and state = 'published' and published_url = 'https://blog.example/p'$$, 1, 'the publish transition stores the URL');
select expect_fail($$update articles set published_url = 'https://blog.example/other' where id = '30000000-0000-0000-0000-0000000000d1'$$, 'the URL can not change after publishing');
select expect_fail($$update articles set published_url = null where id = '30000000-0000-0000-0000-0000000000d1'$$, 'the URL can not be cleared by hand');
select as_user('00000000-0000-0000-0000-0000000000a4'); -- reviewerA
select expect_fail($$update articles set published_url = 'https://blog.example/other' where id = '30000000-0000-0000-0000-0000000000d1'$$, 'a reviewer can not change the URL of a published article');
select as_user('00000000-0000-0000-0000-0000000000a1');

update articles set state = 'monitoring' where id = '30000000-0000-0000-0000-0000000000d1';
select expect_fail($$update articles set state = 'update_due', published_url = 'https://blog.example/other' where id = '30000000-0000-0000-0000-0000000000d1'$$, 'the URL can not change on a later transition');
update articles set state = 'update_due' where id = '30000000-0000-0000-0000-0000000000d1';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-0000000000d1' and published_url = 'https://blog.example/p'$$, 1, 'the URL survives monitoring and update_due');
update articles set state = 'drafting' where id = '30000000-0000-0000-0000-0000000000d1';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-0000000000d1' and state = 'drafting' and published_url is null$$, 1, 'going back to drafting clears the URL');
update articles set body = E'## 해결\n수정한 본문', state = 'drafting' where id = '30000000-0000-0000-0000-0000000000d2';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-0000000000d2' and state = 'drafting' and published_url is null$$, 1, 'editing a published article clears the URL');
update articles set body = E'## 해결\n수정한 본문', state = 'approval_pending' where id = '30000000-0000-0000-0000-0000000000d3';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-0000000000d3' and state = 'approval_pending' and published_url is null$$, 1, 'an edit sent straight to review also clears the URL');

-- articles published before 0009 have no URL and may move on without one
insert into articles (id, workspace_id, owner_id, state, title, body, source_url) values
  ('30000000-0000-0000-0000-0000000000e1', '10000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-0000000000a1', 'drafting', 'T', E'## 해결\n본문 내용', 'https://example.com/x');
reset role;
alter table articles disable trigger articles_rules;
update articles set state = 'published' where id = '30000000-0000-0000-0000-0000000000e1';
alter table articles enable trigger articles_rules;
select as_user('00000000-0000-0000-0000-0000000000a1');
update articles set state = 'monitoring' where id = '30000000-0000-0000-0000-0000000000e1';
update articles set state = 'update_due' where id = '30000000-0000-0000-0000-0000000000e1';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-0000000000e1' and state = 'update_due' and published_url is null$$, 1, 'older published rows move on with a NULL URL');
reset role;
-- ================= 0010: display profiles, hash v2, delivery check =================
create function expect_verdict(article text, renderer text, want text, label text) returns void language plpgsql as $$
declare got jsonb;
begin
  got := article_delivery_check(article::uuid, renderer);
  if (want = 'ok' and (got->>'ok')::boolean is not true) or (want <> 'ok' and got->>'reason' is distinct from want) then
    raise exception 'FAIL: % (got %, want %)', label, got, want;
  end if;
  raise notice 'PASS: %', label;
end $$;
grant execute on function expect_verdict(text, text, text, text) to authenticated;

select as_user('00000000-0000-0000-0000-0000000000a1');
insert into articles (id, workspace_id, owner_id, state, title, body, source_url) values
  ('30000000-0000-0000-0000-0000000000f1', '10000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-0000000000a1', 'drafting', 'T', E'## 해결\n본문 내용', 'https://example.com/x');
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-0000000000f1' and layout_profile = 'L01' and ad_profile = 'A00' and renderer_version is null$$, 1, 'new articles start with the default profiles');
select expect_fail($$update articles set layout_profile = 'L99' where id = '30000000-0000-0000-0000-0000000000f1'$$, 'unknown layout profile rejected');
select expect_fail($$update articles set ad_profile = 'A99' where id = '30000000-0000-0000-0000-0000000000f1'$$, 'unknown ad profile rejected');
select expect_fail($$insert into articles (workspace_id, owner_id, renderer_version)
  values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'r1')$$, 'a new article has no renderer version');
select expect_fail($$update articles set renderer_version = 'r1' where id = '30000000-0000-0000-0000-0000000000f1'$$, 'the renderer version can not be set while drafting');
select expect_verdict('30000000-0000-0000-0000-0000000000f1', 'r1', 'not_approved', 'an unapproved article is refused');

update articles set state = 'approval_pending' where id = '30000000-0000-0000-0000-0000000000f1';
select expect_fail($$update articles set renderer_version = 'r1', state = 'needs_revision' where id = '30000000-0000-0000-0000-0000000000f1'$$, 'the renderer version only moves with an approval');
update articles set state = 'approved', evidence_status = 'ok', rights_status = 'ok', renderer_version = 'r1' where id = '30000000-0000-0000-0000-0000000000f1';
select expect_count($$select count(*) from article_versions where article_id = '30000000-0000-0000-0000-0000000000f1'
  and hash_version = 2 and renderer_version = 'r1' and layout_profile = 'L01' and ad_profile = 'A00'
  and source_url = 'https://example.com/x' and template_id = 'T01' and platform = 'wordpress'$$, 1, 'approval snapshots the v2 fields');
select expect_count($$select count(*) from article_versions v where article_id = '30000000-0000-0000-0000-0000000000f1'
  and content_hash = article_content_hash_v2('T', E'## 해결\n본문 내용', 'https://example.com/x', 'T01', 'wordpress', 'L01', 'A00', 'r1')$$, 1, 'approval stores the v2 hash');
select expect_verdict('30000000-0000-0000-0000-0000000000f1', 'r1', 'ok', 'an article approved under this renderer may be delivered');
select expect_verdict('30000000-0000-0000-0000-0000000000f1', 'r2', 'renderer_mismatch', 'another renderer version is refused');
select expect_verdict('30000000-0000-0000-0000-0000000000f1', null, 'renderer_mismatch', 'a missing renderer version is refused');
select expect_fail($$update articles set renderer_version = 'r2' where id = '30000000-0000-0000-0000-0000000000f1'$$, 'an approved article can not swap its renderer version');

-- a profile change is an edit: it voids the approval
select expect_fail($$update articles set layout_profile = 'L02' where id = '30000000-0000-0000-0000-0000000000f1'$$, 'a layout change can not keep the approval');
select expect_fail($$update articles set ad_profile = 'A01' where id = '30000000-0000-0000-0000-0000000000f1'$$, 'an ad profile change can not keep the approval');
select as_user('00000000-0000-0000-0000-0000000000a4'); -- reviewerA
select expect_fail($$update articles set state = 'drafting', ad_profile = 'A01' where id = '30000000-0000-0000-0000-0000000000f1'$$, 'a reviewer can not change a profile');
select as_user('00000000-0000-0000-0000-0000000000a3'); -- viewerA
select expect_verdict('30000000-0000-0000-0000-0000000000f1', 'r1', 'ok', 'any member can read the verdict');
select as_user('00000000-0000-0000-0000-0000000000a1');
update articles set layout_profile = 'L02', state = 'drafting' where id = '30000000-0000-0000-0000-0000000000f1';
select expect_verdict('30000000-0000-0000-0000-0000000000f1', 'r1', 'not_approved', 'the profile edit voided the approval');
update articles set state = 'approval_pending' where id = '30000000-0000-0000-0000-0000000000f1';
update articles set state = 'approved', evidence_status = 'ok', rights_status = 'ok', renderer_version = 'r1' where id = '30000000-0000-0000-0000-0000000000f1';
select expect_count($$select count(*) from article_versions where article_id = '30000000-0000-0000-0000-0000000000f1' and version = 2 and layout_profile = 'L02'$$, 1, 're-approval snapshots the new profile');
select expect_verdict('30000000-0000-0000-0000-0000000000f1', 'r1', 'ok', 'a re-approved article may be delivered');

-- other workspaces, anon
select as_user('00000000-0000-0000-0000-0000000000b1'); -- ownerB
select expect_verdict('30000000-0000-0000-0000-0000000000f1', 'r1', 'not_found', 'another workspace can not see the verdict');
reset role;
set role anon;
select expect_fail($$select article_delivery_check('30000000-0000-0000-0000-0000000000f1', 'r1')$$, 'anon can not call the delivery check');
reset role;

-- a member can add a snapshot, but one no person approved does not count
select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
insert into article_versions (workspace_id, article_id, version, title, markdown, content_hash, created_by, renderer_version, hash_version)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000f1', 99, 'x', 'x', 'forged', '00000000-0000-0000-0000-0000000000a2', 'r9', 2);
select expect_verdict('30000000-0000-0000-0000-0000000000f1', 'r1', 'ok', 'an unapproved snapshot is ignored');
select as_user('00000000-0000-0000-0000-0000000000a1');

-- an approval made without the server stamp has no renderer version and is refused
insert into articles (id, workspace_id, owner_id, state, title, body, source_url) values
  ('30000000-0000-0000-0000-0000000000f2', '10000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-0000000000a1', 'drafting', 'T', E'## 해결\n본문 내용', 'https://example.com/x');
update articles set state = 'approval_pending' where id = '30000000-0000-0000-0000-0000000000f2';
update articles set state = 'approved', evidence_status = 'ok', rights_status = 'ok' where id = '30000000-0000-0000-0000-0000000000f2';
select expect_count($$select count(*) from article_versions where article_id = '30000000-0000-0000-0000-0000000000f2' and hash_version = 2 and renderer_version is null$$, 1, 'an unstamped approval keeps a NULL renderer version');
select expect_verdict('30000000-0000-0000-0000-0000000000f2', 'r1', 'renderer_mismatch', 'a NULL renderer version is refused');
select expect_verdict('30000000-0000-0000-0000-0000000000f2', null, 'renderer_mismatch', 'NULL never matches NULL');

-- content changed behind the trigger's back
reset role;
alter table articles disable trigger articles_rules;
update articles set body = E'## 해결\n몰래 바꾼 본문' where id = '30000000-0000-0000-0000-0000000000f1';
alter table articles enable trigger articles_rules;
select as_user('00000000-0000-0000-0000-0000000000a1');
select expect_verdict('30000000-0000-0000-0000-0000000000f1', 'r1', 'hash_mismatch', 'a hash that no longer matches is refused');

-- approved under hash v1 (before 0010), or with no approval at all
reset role;
alter table articles disable trigger articles_rules;
insert into articles (id, workspace_id, owner_id, state, title, body, source_url) values
  ('30000000-0000-0000-0000-0000000000f3', '10000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-0000000000a1', 'export_ready', 'T', E'## 해결\n본문 내용', 'https://example.com/x'),
  ('30000000-0000-0000-0000-0000000000f4', '10000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-0000000000a1', 'export_ready', 'T', E'## 해결\n본문 내용', 'https://example.com/x');
alter table articles enable trigger articles_rules;
insert into article_versions (id, workspace_id, article_id, version, title, markdown, content_hash, created_by) values
  ('40000000-0000-0000-0000-0000000000f3', '10000000-0000-0000-0000-00000000000a',
   '30000000-0000-0000-0000-0000000000f3', 1, 'T', E'## 해결\n본문 내용', 'v1hash', '00000000-0000-0000-0000-0000000000a1');
insert into approvals (workspace_id, article_version_id, reviewer_id, decision, snapshot_hash) values
  ('10000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1', 'approved', 'v1hash');
select as_user('00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from article_versions where article_id = '30000000-0000-0000-0000-0000000000f3' and hash_version is null and renderer_version is null$$, 1, 'older snapshots stay NULL (no backfill)');
select expect_verdict('30000000-0000-0000-0000-0000000000f3', 'r1', 'hash_version', 'a v1 approval has to be approved again');
select expect_verdict('30000000-0000-0000-0000-0000000000f4', 'r1', 'no_approval', 'an approved state without an approval is refused');
update articles set state = 'drafting' where id = '30000000-0000-0000-0000-0000000000f3';
update articles set state = 'approval_pending' where id = '30000000-0000-0000-0000-0000000000f3';
update articles set state = 'approved', evidence_status = 'ok', rights_status = 'ok', renderer_version = 'r1' where id = '30000000-0000-0000-0000-0000000000f3';
select expect_verdict('30000000-0000-0000-0000-0000000000f3', 'r1', 'ok', 're-approval clears a v1 article');

-- hash v2 has no NULL or delimiter collisions
reset role;
select expect_count($$select count(*) from (values (1)) x where article_content_hash_v2('a', null, 'b', 'c', 'd', 'e', 'f', 'g') = article_content_hash_v2('a', 'b', null, 'c', 'd', 'e', 'f', 'g')$$, 0, 'a NULL field does not shift the next one');
select expect_count($$select count(*) from (values (1)) x where article_content_hash_v2('a', null, 'b', 'c', 'd', 'e', 'f', 'g') = article_content_hash_v2('a', '', 'b', 'c', 'd', 'e', 'f', 'g')$$, 0, 'NULL and empty text differ');
select expect_count($$select count(*) from (values (1)) x where article_content_hash_v2(E'a\x1fb', 'c', 'x', 'c', 'd', 'e', 'f', 'g') = article_content_hash_v2('a', E'b\x1fc', 'x', 'c', 'd', 'e', 'f', 'g')$$, 0, 'the v1 separator does not join fields');
select expect_count($$select count(*) from (values (1)) x where article_content_hash_v2('a', 'b', 'c', 'd', 'e', 'L01', 'f', 'g') = article_content_hash_v2('a', 'b', 'c', 'd', 'e', 'L02', 'f', 'g')$$, 0, 'the layout profile is part of the hash');
select expect_count($$select count(*) from (values (1)) x where article_content_hash_v2('a', 'b', 'c', 'd', 'e', 'f', 'A00', 'g') = article_content_hash_v2('a', 'b', 'c', 'd', 'e', 'f', 'A01', 'g')$$, 0, 'the ad profile is part of the hash');
select expect_count($$select count(*) from (values (1)) x where article_content_hash_v2('a', 'b', 'c', 'd', 'e', 'f', 'g', 'r1') = article_content_hash_v2('a', 'b', 'c', 'd', 'e', 'f', 'g', 'r2')$$, 0, 'the renderer version is part of the hash');
reset role;
-- ---- site readiness checks (0011) ----
select as_user('00000000-0000-0000-0000-0000000000a1'); -- ownerA
insert into site_checks (workspace_id, check_key, status, evidence_url) values
  ('10000000-0000-0000-0000-00000000000a', 'ads_txt', 'pass', 'https://a.example/ads.txt');
select expect_count($$select count(*) from site_checks where check_key = 'ads_txt' and checked_by = '00000000-0000-0000-0000-0000000000a1' and checked_at > now() - interval '1 minute'$$, 1, 'the checker and time come from the session');

-- the stamp can not be forged on insert, update or upsert
insert into site_checks (workspace_id, check_key, status, checked_by, checked_at) values
  ('10000000-0000-0000-0000-00000000000a', 'post_launch', 'unknown', '00000000-0000-0000-0000-0000000000a2', '2000-01-01');
select expect_count($$select count(*) from site_checks where check_key = 'post_launch' and checked_by = '00000000-0000-0000-0000-0000000000a1' and checked_at > '2020-01-01'$$, 1, 'a forged stamp is replaced on insert');
update site_checks set checked_by = '00000000-0000-0000-0000-0000000000a2', checked_at = '2000-01-01' where check_key = 'ads_txt';
select expect_count($$select count(*) from site_checks where check_key = 'ads_txt' and checked_by = '00000000-0000-0000-0000-0000000000a1' and checked_at > '2020-01-01'$$, 1, 'a forged stamp is replaced on update');
insert into site_checks (workspace_id, check_key, status, note) values
  ('10000000-0000-0000-0000-00000000000a', 'ads_txt', 'fail', '404 응답')
  on conflict (workspace_id, check_key) do update set status = excluded.status, note = excluded.note;
select expect_count($$select count(*) from site_checks where check_key = 'ads_txt'$$, 1, 'one record per item');
select expect_count($$select count(*) from site_checks where check_key = 'ads_txt' and status = 'fail'$$, 1, 'a new record replaces the old one');

-- values
select expect_fail($$insert into site_checks (workspace_id, check_key, status) values ('10000000-0000-0000-0000-00000000000a', 'ownership_access', 'pass')$$, 'a pass needs evidence');
select expect_fail($$insert into site_checks (workspace_id, check_key, status, note) values ('10000000-0000-0000-0000-00000000000a', 'ownership_access', 'not_applicable', '   ')$$, 'a blank note is not evidence');
select expect_fail($$insert into site_checks (workspace_id, check_key, status, note) values ('10000000-0000-0000-0000-00000000000a', 'made_up', 'pass', 'n')$$, 'unknown items are refused');
select expect_fail($$insert into site_checks (workspace_id, check_key, status, note) values ('10000000-0000-0000-0000-00000000000a', 'ownership_access', 'active', 'n')$$, 'an ad status is refused on a check item');
select expect_fail($$insert into site_checks (workspace_id, check_key, status, note) values ('10000000-0000-0000-0000-00000000000a', 'ad_status', 'pass', 'n')$$, 'a check result is refused on the ad status');
select expect_fail($$insert into site_checks (workspace_id, check_key, status, evidence_url) values ('10000000-0000-0000-0000-00000000000a', 'ownership_access', 'pass', 'javascript:alert(1)')$$, 'only http(s) evidence links');

-- roles: every member reads, only owner/admin write
select as_user('00000000-0000-0000-0000-0000000000a3'); -- viewerA
select expect_count('select count(*) from site_checks', 2, 'a viewer can read site checks');
select expect_fail($$insert into site_checks (workspace_id, check_key, status) values ('10000000-0000-0000-0000-00000000000a', 'operator_privacy', 'unknown')$$, 'a viewer can not record a check');
select as_user('00000000-0000-0000-0000-0000000000a4'); -- reviewerA
select expect_fail($$insert into site_checks (workspace_id, check_key, status) values ('10000000-0000-0000-0000-00000000000a', 'operator_privacy', 'unknown')$$, 'a reviewer can not record a check');
select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
select expect_fail($$insert into site_checks (workspace_id, check_key, status) values ('10000000-0000-0000-0000-00000000000a', 'operator_privacy', 'unknown')$$, 'an editor can not record a check');
update site_checks set status = 'pass', note = 'x' where check_key = 'ads_txt';
select expect_count($$select count(*) from site_checks where check_key = 'ads_txt' and status = 'fail'$$, 1, 'an editor can not change a check');

-- other workspaces
select as_user('00000000-0000-0000-0000-0000000000b1'); -- ownerB
select expect_count('select count(*) from site_checks', 0, 'another workspace sees no site checks');
update site_checks set status = 'pass', note = 'x' where check_key = 'ads_txt';
delete from site_checks where check_key = 'ads_txt';
select expect_fail($$insert into site_checks (workspace_id, check_key, status) values ('10000000-0000-0000-0000-00000000000a', 'operator_privacy', 'unknown')$$, 'an owner of B can not write into A');
select as_user('00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from site_checks where check_key = 'ads_txt' and status = 'fail'$$, 1, 'B changed and deleted nothing in A');
select expect_fail($$update site_checks set workspace_id = '10000000-0000-0000-0000-00000000000b' where check_key = 'ads_txt'$$, 'a non-member can not move a check to B');
reset role;
insert into memberships values ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000a1', 'admin');
select as_user('00000000-0000-0000-0000-0000000000a1');
select expect_fail($$update site_checks set workspace_id = '10000000-0000-0000-0000-00000000000b' where check_key = 'ads_txt'$$, 'even an admin of both can not move a check');
select expect_fail($$update site_checks set check_key = 'ownership_access' where check_key = 'ads_txt'$$, 'a record can not become another item');
reset role;
delete from memberships where workspace_id = '10000000-0000-0000-0000-00000000000b' and user_id = '00000000-0000-0000-0000-0000000000a1';
grant select on site_checks to anon;
set role anon;
select expect_count('select count(*) from site_checks', 0, 'anon reads no site checks');
reset role;
revoke select on site_checks from anon;
select as_user('00000000-0000-0000-0000-0000000000a1');
delete from site_checks where check_key = 'ads_txt';
select expect_count($$select count(*) from site_checks where check_key = 'ads_txt'$$, 1, 'records are reset, not deleted');

-- a bad ad status and failed checks hold back nothing: editing, export check, publishing
insert into site_checks (workspace_id, check_key, status, note) values
  ('10000000-0000-0000-0000-00000000000a', 'ad_status', 'rejected', '정책 위반 통지'),
  ('10000000-0000-0000-0000-00000000000a', 'ownership_access', 'fail', '크롤링 차단');
insert into articles (id, workspace_id, owner_id, state, title, body, source_url) values
  ('30000000-0000-0000-0000-0000000000f6', '10000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-0000000000a1', 'drafting', 'T', E'## 해결\n본문 내용', 'https://example.com/x');
update articles set body = E'## 해결\n광고 거절 중에도 수정' where id = '30000000-0000-0000-0000-0000000000f6';
update articles set state = 'approval_pending' where id = '30000000-0000-0000-0000-0000000000f6';
update articles set state = 'approved', evidence_status = 'ok', rights_status = 'ok', renderer_version = 'r1' where id = '30000000-0000-0000-0000-0000000000f6';
select expect_verdict('30000000-0000-0000-0000-0000000000f6', 'r1', 'ok', 'a rejected ad status does not block the delivery check');
update articles set state = 'export_ready' where id = '30000000-0000-0000-0000-0000000000f6';
update articles set state = 'publishing' where id = '30000000-0000-0000-0000-0000000000f6';
update articles set state = 'draft_created', remote = '{"postId":8,"url":"https://x/?p=8"}' where id = '30000000-0000-0000-0000-0000000000f6';
update articles set state = 'published', published_url = 'https://blog.example/f6' where id = '30000000-0000-0000-0000-0000000000f6';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-0000000000f6' and state = 'published'$$, 1, 'a rejected ad status does not block publishing');
update site_checks set status = 'limited' where check_key = 'ad_status';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-0000000000f6' and state = 'published'$$, 1, 'an ad status change does not touch articles');
reset role;

-- ================= 0012: revenue report period, cost ledger, improvement queue =================
create function expect_error(stmt text, pattern text, label text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if sqlerrm !~ pattern then raise exception 'FAIL: % (wrong error: %)', label, sqlerrm; end if;
    raise notice 'PASS (blocked): %', label;
    return;
  end;
  raise exception 'FAIL (was allowed): %', label;
end $$;
grant execute on function expect_error(text, text, text) to authenticated;
-- A report row of workspace A in Asia/Seoul, site level unless a page is given.
create function rev(key text, day text, p_from text, p_to text, tz text default 'Asia/Seoul', cur text default 'KRW', src text default 'AdSense', st text default 'estimated', pg text default '')
returns text language sql as $$
  select format('insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, timezone, period_start, period_end, page, revenue, created_by)
    values (''10000000-0000-0000-0000-00000000000a'', %L, %L, %L, %L, %L, %L, %L, %L, %L, 10, ''00000000-0000-0000-0000-0000000000a1'')',
    key, src, st, cur, day, tz, p_from, p_to, pg)
$$;
grant execute on function rev(text, text, text, text, text, text, text, text, text) to authenticated;

select as_user('00000000-0000-0000-0000-0000000000a1'); -- ownerA
select expect_count(rev('r1', '2026-10-01', '2026-10-01', '2026-10-10') || ' returning 1', 1, 'a report row with zone and period is stored');
select expect_count(rev('r2', '2026-10-10', '2026-10-01', '2026-10-10') || ' returning 1', 1, 'more rows of the same period are stored');
select expect_count(rev('r1', '2026-10-01', '2026-10-01', '2026-10-10') || ' on conflict (workspace_id, row_key) do nothing returning 1', 0, 'an identical re-import inserts nothing');
select expect_count('select count(*) from revenue_rows', 2, 'an identical re-import does not add rows');
select expect_count('select sum(revenue)::int from revenue_rows', 20, 'an identical re-import does not change the total');
select expect_error(rev('x1', '2026-10-10', '2026-10-05', '2026-10-15'), 'period overlap', 'a period running past the stored one is refused');
select expect_error(rev('x2', '2026-09-30', '2026-09-25', '2026-10-01'), 'period overlap', 'a period touching the first stored day is refused');
select expect_error(rev('x3', '2026-10-03', '2026-10-02', '2026-10-04'), 'period overlap', 'a period inside the stored one is refused');
select expect_error(rev('x4', '2026-10-03', '2026-09-01', '2026-11-01'), 'period overlap', 'a period enclosing the stored one is refused');
select expect_error(rev('x5', '2026-10-05', '2026-10-05', '2026-10-05', src => ' adsense'), 'period overlap', 'the source name is compared without case or padding');
select expect_count('select count(*) from revenue_rows', 2, 'refused imports leave nothing behind');
-- one statement holding a good row and a clashing row stores neither
select expect_error($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, timezone, period_start, period_end, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'y1', 'AdSense', 'estimated', 'KRW', '2026-12-01', 'Asia/Seoul', '2026-12-01', '2026-12-01', 1, '00000000-0000-0000-0000-0000000000a1'),
         ('10000000-0000-0000-0000-00000000000a', 'y2', 'AdSense', 'estimated', 'KRW', '2026-10-03', 'Asia/Seoul', '2026-10-02', '2026-10-04', 1, '00000000-0000-0000-0000-0000000000a1')$$, 'period overlap', 'a statement with one clashing row fails');
select expect_count($$select count(*) from revenue_rows where row_key in ('y1', 'y2')$$, 0, 'the whole clashing statement is rolled back');
select expect_count(rev('a1', '2026-10-11', '2026-10-11', '2026-10-20') || ' returning 1', 1, 'an adjacent period is not an overlap');
select expect_count(rev('o1', '2026-10-03', '2026-10-02', '2026-10-04', tz => 'UTC') || ' returning 1', 1, 'another time zone is another report');
select expect_count(rev('o2', '2026-10-03', '2026-10-02', '2026-10-04', cur => 'USD') || ' returning 1', 1, 'another currency is another report');
select expect_count(rev('o3', '2026-10-03', '2026-10-02', '2026-10-04', st => 'finalized') || ' returning 1', 1, 'a finalized report is another report');
select expect_count(rev('o4', '2026-10-03', '2026-10-02', '2026-10-04', src => 'Coupang') || ' returning 1', 1, 'another source is another report');
select expect_count(rev('o5', '2026-10-03', '2026-10-02', '2026-10-04', pg => '/a') || ' returning 1', 1, 'page detail is apart from the site total');
select expect_error(rev('b1', '2026-10-30', '2026-10-30', '2026-10-30', tz => null), 'revenue_rows_report_context', 'a new row needs a time zone');
select expect_error(rev('b2', '2026-10-30', null, '2026-10-30'), 'revenue_rows_report_context', 'a new row needs a period');
select expect_error(rev('b3', '2026-10-31', '2026-10-30', '2026-10-30'), 'revenue_rows_report_context', 'a row can not fall outside its period');
select expect_error(rev('b4', '2026-10-30', '2026-10-31', '2026-10-30'), 'revenue_rows_report_context', 'a period can not run backwards');
select expect_error(rev('b5', '2026-10-30', '2026-10-30', '2026-10-30', tz => 'bad zone'), 'revenue_rows_report_context', 'a zone name must look like one');
select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
select expect_fail(rev('e1', '2026-11-20', '2026-11-20', '2026-11-20'), 'an editor can not import a report');
select as_user('00000000-0000-0000-0000-0000000000b1'); -- ownerB
select expect_fail(rev('w1', '2026-10-03', '2026-10-02', '2026-10-04'), 'an owner of B can not import into A');
-- B's own report over the same days is unrelated to A's
select expect_count($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, timezone, period_start, period_end, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000b', 'w2', 'AdSense', 'estimated', 'KRW', '2026-10-03', 'Asia/Seoul', '2026-10-02', '2026-10-04', 1, '00000000-0000-0000-0000-0000000000b1') returning 1$$, 1, 'workspaces do not overlap each other');
reset role;
-- rows from before 0012 have no zone or period; simulate one and restore the rule
select pg_get_constraintdef(oid) as report_context from pg_constraint where conname = 'revenue_rows_report_context' \gset
alter table revenue_rows drop constraint revenue_rows_report_context;
insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'legacy', 'Legacy', 'estimated', 'KRW', '2026-08-05', 1, '00000000-0000-0000-0000-0000000000a1');
alter table revenue_rows add constraint revenue_rows_report_context :report_context;
select as_user('00000000-0000-0000-0000-0000000000a1');
select expect_error(rev('l1', '2026-08-01', '2026-08-01', '2026-08-10', src => 'Legacy'), 'period overlap', 'a row with no recorded zone blocks overlapping dates');
select expect_count(rev('l2', '2026-08-06', '2026-08-06', '2026-08-10', src => 'Legacy') || ' returning 1', 1, 'dates after the old row are importable');
delete from revenue_rows;
reset role;
delete from revenue_rows;

-- cost ledger
select as_user('00000000-0000-0000-0000-0000000000a1'); -- ownerA
insert into cost_entries (id, workspace_id, category, amount, currency, occurred_on, created_by) values
  ('70000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000a', 'hosting', 12.5, 'USD', '2026-10-01', '00000000-0000-0000-0000-0000000000a1'),
  ('70000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-00000000000a', 'labor', 50000, 'KRW', '2026-10-02', '00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from cost_entries where provenance = 'manual'$$, 2, 'entries are marked manual');
select expect_fail($$insert into cost_entries (workspace_id, category, amount, currency, occurred_on, provenance, created_by) values ('10000000-0000-0000-0000-00000000000a', 'model', 1, 'USD', '2026-10-01', 'model', '00000000-0000-0000-0000-0000000000a1')$$, 'only manual provenance is accepted');
select expect_fail($$insert into cost_entries (workspace_id, category, amount, currency, occurred_on, created_by) values ('10000000-0000-0000-0000-00000000000a', 'model', 0, 'USD', '2026-10-01', '00000000-0000-0000-0000-0000000000a1')$$, 'a zero amount is refused');
select expect_fail($$insert into cost_entries (workspace_id, category, amount, currency, occurred_on, created_by) values ('10000000-0000-0000-0000-00000000000a', 'made_up', 1, 'USD', '2026-10-01', '00000000-0000-0000-0000-0000000000a1')$$, 'an unknown category is refused');
select expect_fail($$insert into cost_entries (workspace_id, category, amount, currency, occurred_on, created_by) values ('10000000-0000-0000-0000-00000000000a', 'model', 1, 'won', '2026-10-01', '00000000-0000-0000-0000-0000000000a1')$$, 'a bad currency is refused');
select expect_fail($$insert into cost_entries (workspace_id, category, amount, currency, occurred_on, created_by) values ('10000000-0000-0000-0000-00000000000a', 'model', 1, 'USD', '2026-10-01', '00000000-0000-0000-0000-0000000000a2')$$, 'the author can not be forged');
select expect_error($$select agent_run_id from cost_entries$$, 'does not exist', 'the ledger has no link to AI call estimates');
insert into agent_runs (workspace_id, task, model, prompt_version, status, tokens_in, tokens_out, duration_ms, cost_estimate, cost_currency, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'draft', 'm', 'v1', 'succeeded', 1, 1, 1, 99, 'USD', '00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from cost_entries$$, 2, 'an AI call adds nothing to the ledger');
update cost_entries set amount = 1 where id = '70000000-0000-0000-0000-000000000001';
select expect_count($$select count(*) from cost_entries where amount = 12.5$$, 1, 'entries are not edited in place');
select as_user('00000000-0000-0000-0000-0000000000a3'); -- viewerA
select expect_count('select count(*) from cost_entries', 2, 'a viewer can read the ledger');
select expect_fail($$insert into cost_entries (workspace_id, category, amount, currency, occurred_on, created_by) values ('10000000-0000-0000-0000-00000000000a', 'model', 1, 'USD', '2026-10-01', '00000000-0000-0000-0000-0000000000a3')$$, 'a viewer can not record a cost');
select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
select expect_fail($$insert into cost_entries (workspace_id, category, amount, currency, occurred_on, created_by) values ('10000000-0000-0000-0000-00000000000a', 'model', 1, 'USD', '2026-10-01', '00000000-0000-0000-0000-0000000000a2')$$, 'an editor can not record a cost');
delete from cost_entries;
select expect_count('select count(*) from cost_entries', 2, 'an editor can not delete a cost');
select as_user('00000000-0000-0000-0000-0000000000a4'); -- reviewerA
select expect_fail($$insert into cost_entries (workspace_id, category, amount, currency, occurred_on, created_by) values ('10000000-0000-0000-0000-00000000000a', 'model', 1, 'USD', '2026-10-01', '00000000-0000-0000-0000-0000000000a4')$$, 'a reviewer can not record a cost');
select as_user('00000000-0000-0000-0000-0000000000b1'); -- ownerB
select expect_count('select count(*) from cost_entries', 0, 'another workspace sees no costs');
select expect_fail($$insert into cost_entries (workspace_id, category, amount, currency, occurred_on, created_by) values ('10000000-0000-0000-0000-00000000000a', 'model', 1, 'USD', '2026-10-01', '00000000-0000-0000-0000-0000000000b1')$$, 'an owner of B can not write into the ledger of A');
delete from cost_entries;
select as_user('00000000-0000-0000-0000-0000000000a1');
select expect_count('select count(*) from cost_entries', 2, 'B deleted nothing in A');
delete from cost_entries where id = '70000000-0000-0000-0000-000000000002';
select expect_count('select count(*) from cost_entries', 1, 'an owner can delete a mistaken entry');

-- improvement queue. f6 is a published article of A with approved version 1.
select as_user('00000000-0000-0000-0000-0000000000b1');
insert into articles (id, workspace_id, owner_id, state) values
  ('30000000-0000-0000-0000-0000000000f7', '10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'idea');
reset role;
create function task(ws text, article text, assignee text, author text) returns text language sql as $$
  select format('insert into improvement_tasks (workspace_id, article_id, target_url, evidence, observed_from, observed_to, assignee_id, review_at, created_by)
    values (%L, %L, ''https://blog.example/f6'', ''CTR 0.4%%'', ''2026-10-01'', ''2026-10-31'', %L, ''2026-12-01'', %L)', ws, article, assignee, author)
$$;
grant execute on function task(text, text, text, text) to authenticated;
select as_user('00000000-0000-0000-0000-0000000000a4'); -- reviewerA
select expect_count(task('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4') || ' returning 1', 1, 'a reviewer can add a task');
select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
select expect_count(task('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a2') || ' returning 1', 1, 'an editor can add a task');
select expect_fail(task('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a1'), 'the author can not be forged');
select expect_error(task('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000f6', null, '00000000-0000-0000-0000-0000000000a2'), 'needs an assignee', 'a new task needs an assignee');
select expect_error(task('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000f7', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a2'), 'foreign key', 'an article of another workspace is refused');
select expect_error(task('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a2'), 'foreign key', 'an assignee from another workspace is refused');
select expect_fail(replace(task('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a2'), 'https://blog.example/f6', 'javascript:alert(1)'), 'only http(s) target URLs');
select expect_fail(replace(task('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a2'), 'CTR 0.4%', '   '), 'evidence can not be blank');
select expect_fail(replace(task('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a2'), '2026-10-31', '2026-09-01'), 'the observation period can not run backwards');
select expect_error($$update improvement_tasks set state = 'done' where assignee_id = '00000000-0000-0000-0000-0000000000a4'$$, 'improvement_tasks_done_version', 'done needs a result version');
select expect_error($$update improvement_tasks set state = 'done', result_version = 99 where assignee_id = '00000000-0000-0000-0000-0000000000a4'$$, 'foreign key', 'the result version must exist on that article');
update improvement_tasks set state = 'done', result_version = 1 where assignee_id = '00000000-0000-0000-0000-0000000000a4';
select expect_count($$select count(*) from improvement_tasks where state = 'done' and result_version = 1 and updated_at >= created_at$$, 1, 'a real version closes the task');
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-0000000000f6' and state = 'published'$$, 1, 'finishing a task does not touch the article');
select expect_error($$update improvement_tasks set article_id = '30000000-0000-0000-0000-0000000000f7'$$, 'can not move', 'a task can not move to another article');
select expect_error($$update improvement_tasks set created_by = '00000000-0000-0000-0000-0000000000a1'$$, 'can not move', 'a task can not change its author');
delete from improvement_tasks;
select expect_count('select count(*) from improvement_tasks', 2, 'tasks are cancelled, not deleted');
select as_user('00000000-0000-0000-0000-0000000000a3'); -- viewerA
select expect_count('select count(*) from improvement_tasks', 2, 'a viewer can read the queue');
select expect_fail(task('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3'), 'a viewer can not add a task');
update improvement_tasks set state = 'cancelled';
select expect_count($$select count(*) from improvement_tasks where state = 'cancelled'$$, 0, 'a viewer can not update a task');
select as_user('00000000-0000-0000-0000-0000000000b1'); -- ownerB
select expect_count('select count(*) from improvement_tasks', 0, 'another workspace sees no tasks');
select expect_fail(task('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b1'), 'an owner of B can not add a task to A');
select expect_error(task('10000000-0000-0000-0000-00000000000b', '30000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1'), 'foreign key', 'B can not point a task at an article of A');
update improvement_tasks set state = 'cancelled';
select as_user('00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from improvement_tasks where state = 'cancelled'$$, 0, 'B changed nothing in A');
-- an assignee who leaves keeps the task on the books with no assignee
select expect_count($$select count(*) from improvement_tasks where assignee_id = '00000000-0000-0000-0000-0000000000a2'$$, 1, 'the task names its assignee');
reset role;
delete from memberships where workspace_id = '10000000-0000-0000-0000-00000000000a' and user_id = '00000000-0000-0000-0000-0000000000a2';
select expect_count($$select count(*) from improvement_tasks where assignee_id is null and state = 'open'$$, 1, 'a departing assignee leaves the task unassigned');
insert into memberships values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', 'editor');
select as_user('00000000-0000-0000-0000-0000000000a1');
insert into articles (id, workspace_id, owner_id, state) values
  ('30000000-0000-0000-0000-0000000000f8', '10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'idea');
select expect_count(task('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000f8', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1') || ' returning 1', 1, 'a task on an unapproved article');
delete from articles where id = '30000000-0000-0000-0000-0000000000f8';
select expect_count('select count(*) from improvement_tasks', 2, 'deleting an unapproved article removes its tasks');
reset role;

-- ================= 0013: brief, evidence and rights review, title ratings, template version =================
select as_user('00000000-0000-0000-0000-0000000000a1'); -- ownerA
insert into articles (id, workspace_id, owner_id, state, title, body, source_url, brief_purpose, brief_audience) values
  ('30000000-0000-0000-0000-000000000101', '10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'briefing', 'T', '', '', '', ''),
  ('30000000-0000-0000-0000-000000000102', '10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'drafting', 'T', E'## 해결\n본문 내용', 'https://example.com/x', '', '');
insert into articles (id, workspace_id, owner_id, state, title, body, source_url) values
  ('30000000-0000-0000-0000-000000000103', '10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'drafting', 'T', E'## 해결\n본문 내용', 'https://example.com/x');

-- the brief is required only by the transition that leaves it
select expect_error($$update articles set state = 'drafting' where id = '30000000-0000-0000-0000-000000000101'$$, 'required to leave the brief', 'an empty brief can not be left');
update articles set brief_purpose = '목적' where id = '30000000-0000-0000-0000-000000000101';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000101' and state = 'briefing'$$, 1, 'an incomplete brief still saves');
select expect_error($$update articles set state = 'drafting' where id = '30000000-0000-0000-0000-000000000101'$$, 'required to leave the brief', 'the brief needs an audience');
select expect_error($$update articles set state = 'drafting', brief_audience = '   ' where id = '30000000-0000-0000-0000-000000000101'$$, 'required to leave the brief', 'a blank audience does not count');
update articles set brief_audience = '대상' where id = '30000000-0000-0000-0000-000000000101';
select expect_error($$update articles set state = 'drafting' where id = '30000000-0000-0000-0000-000000000101'$$, 'required to leave the brief', 'the brief needs a source URL');
select expect_error($$update articles set state = 'drafting', source_url = 'ftp://example.com/x' where id = '30000000-0000-0000-0000-000000000101'$$, 'required to leave the brief', 'the brief needs an http(s) source URL');
update articles set state = 'drafting', source_url = 'https://example.com/b' where id = '30000000-0000-0000-0000-000000000101';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000101' and state = 'drafting'$$, 1, 'a complete brief leaves the briefing state');
update articles set title = 'T2' where id = '30000000-0000-0000-0000-000000000102';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000102' and title = 'T2' and brief_purpose = ''$$, 1, 'an older article without a brief keeps saving');
-- 0014: every route into review needs the brief, not only the one that leaves `briefing`
select expect_error($$update articles set state = 'qa_pending' where id = '30000000-0000-0000-0000-000000000102'$$, 'required before review', 'drafting → qa_pending needs the brief');
select expect_error($$update articles set state = 'approval_pending' where id = '30000000-0000-0000-0000-000000000102'$$, 'required before review', 'the one-save route to approval needs the brief');
select expect_error($$update articles set title = 'T3', state = 'qa_pending', brief_purpose = '목적' where id = '30000000-0000-0000-0000-000000000102'$$, 'required before review', 'an edit sent to review needs the whole brief');
update articles set state = 'needs_revision' where id = '30000000-0000-0000-0000-000000000102';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000102' and state = 'needs_revision'$$, 1, 'a failed QA without a brief is still recorded');
update articles set state = 'drafting' where id = '30000000-0000-0000-0000-000000000102';
update articles set brief_purpose = '목적', brief_audience = '대상' where id = '30000000-0000-0000-0000-000000000102';
update articles set state = 'qa_pending' where id = '30000000-0000-0000-0000-000000000102';
update articles set state = 'approval_pending' where id = '30000000-0000-0000-0000-000000000102';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000102' and state = 'approval_pending'$$, 1, 'an article with a brief enters review');

insert into keywords (id, workspace_id, phrase, created_by) values
  ('50000000-0000-0000-0000-00000000000c', '10000000-0000-0000-0000-00000000000a', 'reviewer guard', '00000000-0000-0000-0000-0000000000a1');

-- who may set the review
select expect_error($$insert into articles (workspace_id, owner_id, evidence_status)
  values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'ok')$$, 'starts with evidence and rights unreviewed', 'a new article can not start reviewed');
select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
select expect_error($$update articles set evidence_status = 'ok' where id = '30000000-0000-0000-0000-000000000102'$$, 'only owner, admin or reviewer can set', 'an editor can not set the evidence status');
select expect_error($$update articles set rights_status = 'ok' where id = '30000000-0000-0000-0000-000000000102'$$, 'only owner, admin or reviewer can set', 'an editor can not set the rights status');
select as_user('00000000-0000-0000-0000-0000000000a3'); -- viewerA
update articles set evidence_status = 'ok' where id = '30000000-0000-0000-0000-000000000102';
select as_user('00000000-0000-0000-0000-0000000000b1'); -- ownerB
update articles set evidence_status = 'ok' where id = '30000000-0000-0000-0000-000000000102';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000102'$$, 0, 'another workspace can not see the article');
select as_user('00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000102' and evidence_status = 'unreviewed'$$, 1, 'a viewer and another workspace changed nothing');

-- approval needs both decisions
select expect_error($$update articles set state = 'approved', renderer_version = 'r1' where id = '30000000-0000-0000-0000-000000000102'$$, 'must both be confirmed', 'an unreviewed article can not be approved');
select as_user('00000000-0000-0000-0000-0000000000a4'); -- reviewerA
update articles set evidence_status = 'blocked', rights_status = 'ok' where id = '30000000-0000-0000-0000-000000000102';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000102' and evidence_status = 'blocked' and rights_status = 'ok' and state = 'approval_pending'$$, 1, 'a reviewer can record the review of an article waiting for approval');
select expect_error($$update articles set state = 'approved', renderer_version = 'r1' where id = '30000000-0000-0000-0000-000000000102'$$, 'must both be confirmed', 'blocked evidence can not be approved');
update articles set evidence_status = 'ok', rights_status = 'blocked' where id = '30000000-0000-0000-0000-000000000102';
select expect_error($$update articles set state = 'approved', renderer_version = 'r1' where id = '30000000-0000-0000-0000-000000000102'$$, 'must both be confirmed', 'a rights problem can not be approved');
update articles set rights_status = 'unreviewed' where id = '30000000-0000-0000-0000-000000000102';
select expect_error($$update articles set state = 'approved', renderer_version = 'r1' where id = '30000000-0000-0000-0000-000000000102'$$, 'must both be confirmed', 'unreviewed rights can not be approved');
select expect_error($$update articles set evidence_status = 'ok', title = 'changed' where id = '30000000-0000-0000-0000-000000000102'$$, 'reviewers can only', 'a reviewer can not edit while recording the review');
select expect_error($$update articles set state = 'approval_pending' where id = '30000000-0000-0000-0000-000000000102'$$, 'reviewers can only', 'a reviewer can not save without a decision');
select expect_error($$update articles set keyword_id = '50000000-0000-0000-0000-00000000000c', state = 'needs_revision' where id = '30000000-0000-0000-0000-000000000102'$$, 'reviewers can only', 'a reviewer can not change the keyword link');
select expect_error($$update articles set evidence_status = 'nope' where id = '30000000-0000-0000-0000-000000000102'$$, 'evidence_status_check', 'an unknown status is rejected');
update articles set rights_status = 'ok' where id = '30000000-0000-0000-0000-000000000102';
update articles set state = 'approved', renderer_version = 'r1' where id = '30000000-0000-0000-0000-000000000102';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000102' and state = 'approved'$$, 1, 'an article with both decisions ok is approved');
select expect_verdict('30000000-0000-0000-0000-000000000102', 'r1', 'ok', 'the hash formula still validates the approval');

-- locked after approval, voided by an edit
select expect_error($$update articles set evidence_status = 'blocked' where id = '30000000-0000-0000-0000-000000000102'$$, 'can not change after approval', 'a reviewer can not change the status after approval');
select as_user('00000000-0000-0000-0000-0000000000a1');
select expect_error($$update articles set rights_status = 'blocked' where id = '30000000-0000-0000-0000-000000000102'$$, 'can not change after approval', 'the owner can not change the status after approval');
select expect_error($$update articles set evidence_status = 'blocked', state = 'drafting' where id = '30000000-0000-0000-0000-000000000102'$$, 'can not change after approval', 'leaving approval does not unlock the status in the same update');
update articles set body = E'## 해결\n고친 본문', state = 'drafting' where id = '30000000-0000-0000-0000-000000000102';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000102' and evidence_status = 'unreviewed' and rights_status = 'unreviewed'$$, 1, 'an edit resets the review');
update articles set evidence_status = 'ok', rights_status = 'ok' where id = '30000000-0000-0000-0000-000000000103';
select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
update articles set title = 'T3' where id = '30000000-0000-0000-0000-000000000103';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000103' and evidence_status = 'unreviewed' and rights_status = 'unreviewed'$$, 1, 'an editor''s edit resets the review without setting it');
select as_user('00000000-0000-0000-0000-0000000000a1');
update articles set evidence_status = 'ok', rights_status = 'ok', body = E'## 해결\n같이 고친 본문' where id = '30000000-0000-0000-0000-000000000103';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000103' and evidence_status = 'unreviewed'$$, 1, 'a review sent with an edit does not count');

-- title ratings
select expect_error($$update articles set title_evaluation = '[]' where id = '30000000-0000-0000-0000-000000000103'$$, 'title_evaluation_shape', 'five title candidates are required');
select expect_error($$update articles set title_evaluation = '{"a":1}' where id = '30000000-0000-0000-0000-000000000103'$$, 'title_evaluation_shape', 'title ratings must be a list');
update articles set title_evaluation = '[{"title":"a"},{"title":"b"},{"title":"c"},{"title":"d"},{"title":"e"}]' where id = '30000000-0000-0000-0000-000000000103';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000103' and jsonb_array_length(title_evaluation) = 5$$, 1, 'title ratings are stored');
update articles set state = 'approval_pending', evidence_status = 'ok', rights_status = 'ok' where id = '30000000-0000-0000-0000-000000000103';
select as_user('00000000-0000-0000-0000-0000000000a4'); -- reviewerA
select expect_error($$update articles set title_evaluation = null, state = 'needs_revision' where id = '30000000-0000-0000-0000-000000000103'$$, 'reviewers can only', 'a reviewer can not change title ratings');
select as_user('00000000-0000-0000-0000-0000000000a1');
update articles set state = 'approved', renderer_version = 'r1' where id = '30000000-0000-0000-0000-000000000103';
update articles set title_evaluation = '[{"title":"z"},{"title":"b"},{"title":"c"},{"title":"d"},{"title":"e"}]' where id = '30000000-0000-0000-0000-000000000103';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000103' and state = 'approved' and evidence_status = 'ok'$$, 1, 'title ratings do not void an approval');
select expect_verdict('30000000-0000-0000-0000-000000000103', 'r1', 'ok', 'title ratings do not change the hash');

-- pinned template version
insert into articles (id, workspace_id, owner_id, state, title, body, source_url, template_id, template_version) values
  ('30000000-0000-0000-0000-000000000104', '10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'drafting', 'T', E'## 해결\n본문 내용', 'https://example.com/x', 'T02', 'T02@1');
select expect_error($$insert into articles (workspace_id, owner_id, template_id, template_version)
  values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'T01', 'T02@1')$$, 'template_version_shape', 'a version must belong to its template');
select expect_error($$update articles set template_version = 'T02@9' where id = '30000000-0000-0000-0000-000000000104'$$, 'fixed when the template', 'a version can not change while the template stays');
select expect_error($$update articles set template_version = null where id = '30000000-0000-0000-0000-000000000104'$$, 'fixed when the template', 'a version can not be cleared while the template stays');
update articles set template_id = 'T04', template_version = 'T04@1' where id = '30000000-0000-0000-0000-000000000104';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000104' and template_version = 'T04@1'$$, 1, 'choosing another template pins its version');
update articles set state = 'approval_pending', evidence_status = 'ok', rights_status = 'ok' where id = '30000000-0000-0000-0000-000000000104';
update articles set state = 'approved', renderer_version = 'r1' where id = '30000000-0000-0000-0000-000000000104';
select expect_count($$select count(*) from article_versions where article_id = '30000000-0000-0000-0000-000000000104' and template_version = 'T04@1'$$, 1, 'the approval snapshot keeps the template version');
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000102' and template_version is null$$, 1, 'older articles have no pinned version');
reset role;

-- ---- W9: blog accounts (0015) ----
select expect_count($$select count(*) from blogs where display_name is null$$, 2, 'existing blogs are not backfilled');
select expect_count($$select count(*) from articles where blog_id is not null$$, 0, 'existing articles stay unclassified');
select as_user('00000000-0000-0000-0000-0000000000a1'); -- ownerA
insert into blogs (id, workspace_id, platform, domain, display_name) values
  ('20000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-00000000000a', 'naver', 'blog.naver.com/first', '첫 블로그'),
  ('20000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-00000000000a', 'tistory', 'second.tistory.com', '둘째 블로그');
select expect_error($$update blogs set status = 'gone' where id = '20000000-0000-0000-0000-0000000000a1'$$, 'blogs_status_known', 'an unknown blog status is rejected');
select expect_error($$update blogs set display_name = '   ' where id = '20000000-0000-0000-0000-0000000000a1'$$, 'display_name_check', 'a blank display name is rejected');
select expect_error($$insert into blogs (workspace_id, platform, domain, display_name) values ('10000000-0000-0000-0000-00000000000a', 'naver', '  ', 'x')$$, 'blogs_domain_length', 'a blank address is rejected');
insert into keywords (id, workspace_id, phrase, created_by) values
  ('50000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-00000000000a', '블로그 키워드 1', '00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from keywords where id = '50000000-0000-0000-0000-0000000000b1' and blog_id is null$$, 1, 'a keyword starts unclassified');
update keywords set blog_id = '20000000-0000-0000-0000-0000000000a1' where id = '50000000-0000-0000-0000-0000000000b1';
select expect_count($$select count(*) from keywords where id = '50000000-0000-0000-0000-0000000000b1' and blog_id = '20000000-0000-0000-0000-0000000000a1'$$, 1, 'the owner can link a keyword to a blog');
select expect_error($$update keywords set blog_id = '20000000-0000-0000-0000-00000000000b' where id = '50000000-0000-0000-0000-0000000000b1'$$, 'keywords_blog_fk', 'a keyword can not link to a blog of another workspace');
select expect_error($$update articles set blog_id = '20000000-0000-0000-0000-00000000000b' where id = '30000000-0000-0000-0000-000000000104'$$, 'violates foreign key', 'an article can not move to a blog of another workspace');
select expect_error($$delete from blogs where id = '20000000-0000-0000-0000-0000000000a1'$$, 'keywords_blog_fk', 'a linked blog can not be deleted');

select as_user('00000000-0000-0000-0000-0000000000c3'); -- admin
update blogs set display_name = '첫 블로그(수정)', status = 'archived' where id = '20000000-0000-0000-0000-0000000000a1';
select expect_count($$select count(*) from blogs where id = '20000000-0000-0000-0000-0000000000a1' and display_name = '첫 블로그(수정)' and status = 'archived'$$, 1, 'an admin can edit and archive a blog');
select expect_count($$select count(*) from keywords where blog_id = '20000000-0000-0000-0000-0000000000a1'$$, 1, 'archiving keeps the links');
update blogs set status = 'active' where id = '20000000-0000-0000-0000-0000000000a1';
update keywords set blog_id = null where id = '50000000-0000-0000-0000-0000000000b1';
select expect_count($$select count(*) from keywords where id = '50000000-0000-0000-0000-0000000000b1' and blog_id is null$$, 1, 'an admin can clear the link');

select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
select expect_count($$select count(*) from blogs where id = '20000000-0000-0000-0000-0000000000a1'$$, 1, 'an editor can read blog accounts');
update blogs set display_name = '편집자' where id = '20000000-0000-0000-0000-0000000000a1';
select expect_count($$select count(*) from blogs where id = '20000000-0000-0000-0000-0000000000a1' and display_name = '첫 블로그(수정)'$$, 1, 'an editor can not edit a blog');
select expect_error($$update keywords set blog_id = '20000000-0000-0000-0000-0000000000a1' where id = '50000000-0000-0000-0000-0000000000b1'$$, 'only owner or admin', 'an editor can not link a keyword to a blog');
select expect_error($$insert into keywords (workspace_id, phrase, created_by, blog_id) values ('10000000-0000-0000-0000-00000000000a', '편집자 키워드', '00000000-0000-0000-0000-0000000000a2', '20000000-0000-0000-0000-0000000000a1')$$, 'only owner or admin', 'an editor can not insert a keyword with a blog');
update keywords set note = '편집자 메모' where id = '50000000-0000-0000-0000-0000000000b1';
select expect_count($$select count(*) from keywords where id = '50000000-0000-0000-0000-0000000000b1' and note = '편집자 메모'$$, 1, 'an editor can still edit the rest of a keyword');
select expect_verdict('30000000-0000-0000-0000-000000000104', 'r1', 'ok', 'the article is approved before its blog changes');
select expect_count($$select count(*) from article_versions where article_id = '30000000-0000-0000-0000-000000000104'$$, 1, 'one approval snapshot before the blog changes');
update articles set blog_id = '20000000-0000-0000-0000-0000000000a2' where id = '30000000-0000-0000-0000-000000000104';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000104' and blog_id = '20000000-0000-0000-0000-0000000000a2' and state = 'approved' and evidence_status = 'ok' and rights_status = 'ok'$$, 1, 'an editor can move an article between blogs and the approval stays');
select expect_verdict('30000000-0000-0000-0000-000000000104', 'r1', 'ok', 'the blog is not part of the approval hash');
select expect_count($$select count(*) from article_versions where article_id = '30000000-0000-0000-0000-000000000104'$$, 1, 'changing the blog makes no new snapshot');
update articles set blog_id = null where id = '30000000-0000-0000-0000-000000000104';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000104' and blog_id is null and state = 'approved'$$, 1, 'clearing the blog keeps the approval');
select expect_error($$update articles set blog_id = '20000000-0000-0000-0000-00000000000b' where id = '30000000-0000-0000-0000-000000000104'$$, 'violates foreign key', 'an editor can not link an article to a blog of another workspace');

select as_user('00000000-0000-0000-0000-0000000000a4'); -- reviewerA
select expect_error($$update articles set blog_id = '20000000-0000-0000-0000-0000000000a2' where id = '30000000-0000-0000-0000-000000000104'$$, 'reviewers can only', 'a reviewer can not move an article between blogs');
update keywords set blog_id = '20000000-0000-0000-0000-0000000000a2' where id = '50000000-0000-0000-0000-0000000000b1';
select expect_count($$select count(*) from keywords where id = '50000000-0000-0000-0000-0000000000b1' and blog_id is null$$, 1, 'a reviewer can not link a keyword to a blog');

select as_user('00000000-0000-0000-0000-0000000000a3'); -- viewerA
select expect_fail($$insert into blogs (workspace_id, platform, domain) values ('10000000-0000-0000-0000-00000000000a', 'naver', 'v.example')$$, 'a viewer can not add a blog');

select as_user('00000000-0000-0000-0000-0000000000b1'); -- ownerB
select expect_count($$select count(*) from blogs where id = '20000000-0000-0000-0000-0000000000a1'$$, 0, 'another workspace can not see the blog');
update blogs set display_name = '남의 블로그' where id = '20000000-0000-0000-0000-0000000000a1';
select expect_count($$select count(*) from keywords where id = '50000000-0000-0000-0000-0000000000b1'$$, 0, 'another workspace can not see the keyword');
reset role;
select expect_count($$select count(*) from blogs where id = '20000000-0000-0000-0000-0000000000a1' and display_name = '첫 블로그(수정)'$$, 1, 'another workspace can not edit the blog');

-- ---- W10: keyword trends (0016) ----
create function ins_trend(ws text, blog text, kw text, src text, day text, by_user text, monthly text default '100')
returns void language plpgsql as $$
begin
  execute format($q$insert into keyword_trends (workspace_id, blog_id, keyword, category, monthly_searches, source, measured_on, created_by)
    values (%L, %L, %L, 'IT', %s, %L, %L, %L)
    on conflict (workspace_id, blog_id, keyword_key, category_key, source_key, measured_on) do nothing$q$,
    ws, blog, kw, monthly, src, day, by_user);
end $$;
grant execute on function ins_trend(text, text, text, text, text, text, text) to authenticated;

select as_user('00000000-0000-0000-0000-0000000000a1'); -- ownerA
select ins_trend('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1', '여행 준비물', '블랙키위', '2026-11-01', '00000000-0000-0000-0000-0000000000a1');
select ins_trend('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1', '여행 준비물', '블랙키위', '2026-11-01', '00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from keyword_trends where keyword = '여행 준비물'$$, 1, 'importing the same trend row again adds nothing');
select ins_trend('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1', '  여행   준비물 ', '블랙키위', '2026-11-01', '00000000-0000-0000-0000-0000000000a1', '999');
select expect_count($$select count(*) from keyword_trends where keyword_key = '여행 준비물' and monthly_searches = 100$$, 1, 'a respaced duplicate is skipped and the stored value stays');
select ins_trend('10000000-0000-0000-0000-00000000000a', null, '미분류 키워드', '블랙키위', '2026-11-01', '00000000-0000-0000-0000-0000000000a1');
select ins_trend('10000000-0000-0000-0000-00000000000a', null, '미분류 키워드', '블랙키위', '2026-11-01', '00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from keyword_trends where keyword = '미분류 키워드' and blog_id is null$$, 1, 'unclassified rows are deduplicated too');
select ins_trend('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1', '여행 준비물', '블랙키위', '2026-11-02', '00000000-0000-0000-0000-0000000000a1');
select ins_trend('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1', '여행 준비물', '다른 도구', '2026-11-01', '00000000-0000-0000-0000-0000000000a1');
select ins_trend('10000000-0000-0000-0000-00000000000a', null, '여행 준비물', '블랙키위', '2026-11-01', '00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from keyword_trends where keyword_key = '여행 준비물'$$, 4, 'another date, tool or blog is another measurement');
select expect_count($$select count(*) from keyword_trends where keyword = '미분류 키워드' and growth_pct is null and document_count is null$$, 1, 'missing values stay NULL rather than 0');
insert into keyword_trends (workspace_id, keyword, monthly_searches, growth_pct, document_count, source, measured_on, created_by) values
  ('10000000-0000-0000-0000-00000000000a', '영값', 0, 0, 0, '도구', '2026-11-01', '00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from keyword_trends where keyword = '영값' and monthly_searches = 0 and growth_pct = 0 and document_count = 0$$, 1, 'a real zero is stored as zero');
select expect_error($$insert into keyword_trends (workspace_id, keyword, source, measured_on, created_by) values ('10000000-0000-0000-0000-00000000000a', '값 없음', '도구', '2026-11-01', '00000000-0000-0000-0000-0000000000a1')$$, 'keyword_trends_has_value', 'a trend row needs at least one value');
select expect_error($$insert into keyword_trends (workspace_id, keyword, monthly_searches, source, measured_on, created_by) values ('10000000-0000-0000-0000-00000000000a', '음수', -1, '도구', '2026-11-01', '00000000-0000-0000-0000-0000000000a1')$$, 'monthly_searches_check', 'negative search volume is rejected');
select expect_error($$insert into keyword_trends (workspace_id, keyword, growth_pct, source, measured_on, created_by) values ('10000000-0000-0000-0000-00000000000a', '범위', -100.5, '도구', '2026-11-01', '00000000-0000-0000-0000-0000000000a1')$$, 'growth_pct_check', 'growth below -100 percent is rejected');
select expect_error($$insert into keyword_trends (workspace_id, keyword, monthly_searches, source, measured_on, created_by) values ('10000000-0000-0000-0000-00000000000a', '   ', 1, '도구', '2026-11-01', '00000000-0000-0000-0000-0000000000a1')$$, 'keyword_check', 'a blank keyword is rejected');
select expect_error($$insert into keyword_trends (workspace_id, keyword, monthly_searches, source, measured_on, created_by) values ('10000000-0000-0000-0000-00000000000a', '출처', 1, '  ', '2026-11-01', '00000000-0000-0000-0000-0000000000a1')$$, 'source_check', 'a blank source is rejected');
select expect_error($$select ins_trend('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000b', '남의 블로그', '도구', '2026-11-01', '00000000-0000-0000-0000-0000000000a1')$$, 'keyword_trends_blog_fk', 'a trend can not link to a blog of another workspace');
select expect_error($$delete from blogs where id = '20000000-0000-0000-0000-0000000000a1'$$, 'keyword_trends_blog_fk', 'a blog with trend rows can not be deleted');
select expect_fail($$select ins_trend('10000000-0000-0000-0000-00000000000b', null, '다른 워크스페이스', '도구', '2026-11-01', '00000000-0000-0000-0000-0000000000a1')$$, 'an owner can not write trends into another workspace');
update keyword_trends set monthly_searches = 5 where keyword = '미분류 키워드';
select expect_count($$select count(*) from keyword_trends where keyword = '미분류 키워드' and monthly_searches = 100$$, 1, 'trend rows can not be edited, only replaced');

select as_user('00000000-0000-0000-0000-0000000000c3'); -- admin
select ins_trend('10000000-0000-0000-0000-00000000000a', null, '관리자 키워드', '도구', '2026-11-01', '00000000-0000-0000-0000-0000000000c3');
select expect_count($$select count(*) from keyword_trends where keyword = '관리자 키워드'$$, 1, 'an admin can add a trend');

select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
select ins_trend('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a2', '편집자 키워드', '도구', '2026-11-01', '00000000-0000-0000-0000-0000000000a2');
select expect_count($$select count(*) from keyword_trends where keyword = '편집자 키워드'$$, 1, 'an editor can add a trend');
select expect_fail($$select ins_trend('10000000-0000-0000-0000-00000000000a', null, '위조', '도구', '2026-11-01', '00000000-0000-0000-0000-0000000000a1')$$, 'an editor can not record a trend as someone else');
delete from keyword_trends where keyword = '관리자 키워드';
select expect_count($$select count(*) from keyword_trends where keyword = '관리자 키워드'$$, 0, 'an editor can delete a wrong trend');

select as_user('00000000-0000-0000-0000-0000000000a4'); -- reviewerA
select expect_count($$select count(*) from keyword_trends where keyword = '편집자 키워드'$$, 1, 'a reviewer can read trends');
select expect_fail($$select ins_trend('10000000-0000-0000-0000-00000000000a', null, '검수자', '도구', '2026-11-01', '00000000-0000-0000-0000-0000000000a4')$$, 'a reviewer can not add a trend');
delete from keyword_trends where keyword = '편집자 키워드';

select as_user('00000000-0000-0000-0000-0000000000a3'); -- viewerA
select expect_count($$select count(*) from keyword_trends where keyword = '편집자 키워드'$$, 1, 'a reviewer can not delete a trend and a viewer can read it');
select expect_fail($$select ins_trend('10000000-0000-0000-0000-00000000000a', null, '뷰어', '도구', '2026-11-01', '00000000-0000-0000-0000-0000000000a3')$$, 'a viewer can not add a trend');
delete from keyword_trends where keyword = '편집자 키워드';

select as_user('00000000-0000-0000-0000-0000000000b1'); -- ownerB
select expect_count($$select count(*) from keyword_trends$$, 0, 'another workspace can not see the trends');
delete from keyword_trends where keyword = '편집자 키워드';
select expect_fail($$select ins_trend('10000000-0000-0000-0000-00000000000a', null, '침입', '도구', '2026-11-01', '00000000-0000-0000-0000-0000000000b1')$$, 'another workspace can not add a trend');
reset role;
select expect_count($$select count(*) from keyword_trends where keyword = '편집자 키워드'$$, 1, 'neither a viewer nor another workspace can delete a trend');

-- ---- 0017 blog metric snapshots ----
reset role;
create function ins_metric(ws text, blog text, tool text, metric text, scope text, dim text, day text, by_user text, val text default '10', label text default null)
returns void language plpgsql as $$
begin
  execute format($q$insert into blog_metric_snapshots (workspace_id, blog_id, tool, metric, scope, dimension, value, value_label, measured_on, created_by)
    values (%L, %L, %L, %L, %L, %L, %s, %L, %L, %L)
    on conflict (workspace_id, blog_id, tool, metric_key, scope, dimension_key, measured_on) do nothing$q$,
    ws, blog, tool, metric, scope, dim, coalesce(val, 'null'), label, day, by_user);
end $$;
grant execute on function ins_metric(text, text, text, text, text, text, text, text, text, text) to authenticated;

select as_user('00000000-0000-0000-0000-0000000000a1'); -- ownerA
select ins_metric('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1', 'bseupi', '블로그지수', 'site', '', '2026-11-01', '00000000-0000-0000-0000-0000000000a1', null, '준최4');
select ins_metric('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1', 'bseupi', '블로그지수', 'site', '', '2026-11-01', '00000000-0000-0000-0000-0000000000a1', null, '최적1');
select expect_count($$select count(*) from blog_metric_snapshots where value_label = '준최4'$$, 1, 'the same index measurement again is skipped and the stored label stays');
select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'gsc', '클릭수', 'query', '제주 여행', '2026-11-01', '00000000-0000-0000-0000-0000000000a1');
select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'gsc', '클릭수', 'query', '  제주   여행 ', '2026-11-01', '00000000-0000-0000-0000-0000000000a1', '99');
select expect_count($$select count(*) from blog_metric_snapshots where tool = 'gsc' and value = 10$$, 1, 'a re-imported unclassified query row is a duplicate');
select expect_count($$select count(*) from blog_metric_snapshots where tool = 'gsc'$$, 1, 'a respaced query is the same measurement');
select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'gsc', '클릭수', 'page', 'https://a.example/1', '2026-11-01', '00000000-0000-0000-0000-0000000000a1');
select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'gsc', '클릭수', 'page', 'https://a.example/1/', '2026-11-01', '00000000-0000-0000-0000-0000000000a1');
select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'gsc', '클릭수', 'page', repeat('x', 2000), '2026-11-01', '00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from blog_metric_snapshots where scope = 'page'$$, 3, 'page addresses are compared exactly and a long one fits the key');
select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'blackkiwi', '클릭수', 'query', '제주 여행', '2026-11-01', '00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from blog_metric_snapshots where metric = '클릭수' and scope = 'query'$$, 2, 'another tool is another measurement');
select expect_error($$select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'naver_api', '지수', 'site', '', '2026-11-01', '00000000-0000-0000-0000-0000000000a1')$$, 'tool_check', 'an unknown tool is rejected');
select expect_error($$select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'other', '지수', 'site', '', '2026-11-01', '00000000-0000-0000-0000-0000000000a1', null, null)$$, 'one_value', 'a record needs a value');
select expect_error($$select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'other', '지수', 'site', '', '2026-11-01', '00000000-0000-0000-0000-0000000000a1', '1', '준최1')$$, 'one_value', 'a record has a number or a label, not both');
select expect_error($$select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'gsc', '클릭수', 'query', '  ', '2026-11-01', '00000000-0000-0000-0000-0000000000a1')$$, 'scope_dimension', 'a query row needs the query');
select expect_error($$select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'gsc', '클릭수', 'site', 'x', '2026-11-01', '00000000-0000-0000-0000-0000000000a1')$$, 'scope_dimension', 'a site row has no dimension');
select expect_error($$insert into blog_metric_snapshots (workspace_id, tool, metric, value, measured_on, evidence_url, created_by) values ('10000000-0000-0000-0000-00000000000a', 'other', 'x', 1, '2026-11-01', 'javascript:alert(1)', '00000000-0000-0000-0000-0000000000a1')$$, 'evidence_url_check', 'an evidence URL must be http(s)');
select expect_error($$select ins_metric('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000b', 'other', '지수', 'site', '', '2026-11-01', '00000000-0000-0000-0000-0000000000a1')$$, 'blog_metric_snapshots_blog_fk', 'a record can not link to a blog of another workspace');
select expect_fail($$select ins_metric('10000000-0000-0000-0000-00000000000b', null, 'other', '지수', 'site', '', '2026-11-01', '00000000-0000-0000-0000-0000000000a1')$$, 'an owner can not write records into another workspace');
update blog_metric_snapshots set value_label = '최적1' where tool = 'bseupi';
select expect_count($$select count(*) from blog_metric_snapshots where value_label = '준최4'$$, 1, 'records can not be edited, only replaced');

select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'clarity', '이탈률', 'site', '', '2026-11-01', '00000000-0000-0000-0000-0000000000a2');
select expect_count($$select count(*) from blog_metric_snapshots where tool = 'clarity'$$, 1, 'an editor can add a record');
select expect_fail($$select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'other', '위조', 'site', '', '2026-11-01', '00000000-0000-0000-0000-0000000000a1')$$, 'an editor can not record as someone else');

select as_user('00000000-0000-0000-0000-0000000000a4'); -- reviewerA
select expect_count($$select count(*) from blog_metric_snapshots where tool = 'clarity'$$, 1, 'a reviewer can read records');
select expect_fail($$select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'other', '검수자', 'site', '', '2026-11-01', '00000000-0000-0000-0000-0000000000a4')$$, 'a reviewer can not add a record');
delete from blog_metric_snapshots where tool = 'clarity';

select as_user('00000000-0000-0000-0000-0000000000a3'); -- viewerA
select expect_count($$select count(*) from blog_metric_snapshots where tool = 'clarity'$$, 1, 'a reviewer can not delete a record and a viewer can read it');
select expect_fail($$select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'other', '뷰어', 'site', '', '2026-11-01', '00000000-0000-0000-0000-0000000000a3')$$, 'a viewer can not add a record');
delete from blog_metric_snapshots where tool = 'clarity';

select as_user('00000000-0000-0000-0000-0000000000b1'); -- ownerB
select expect_count($$select count(*) from blog_metric_snapshots$$, 0, 'another workspace can not see the records');
delete from blog_metric_snapshots where tool = 'clarity';
select expect_fail($$select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'other', '침입', 'site', '', '2026-11-01', '00000000-0000-0000-0000-0000000000b1')$$, 'another workspace can not add a record');
reset role;
select expect_count($$select count(*) from blog_metric_snapshots where tool = 'clarity'$$, 1, 'neither a viewer nor another workspace can delete a record');

select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
delete from blog_metric_snapshots where tool = 'clarity';
select expect_count($$select count(*) from blog_metric_snapshots where tool = 'clarity'$$, 0, 'an editor can delete a wrong record');

-- ---- 0018 review fixes ----
-- Fixed character table. The same input -> key pairs are in the app's JS test (normalizePhrase).
reset role;
do $$
declare r record;
begin
  for r in select * from (values
    (1, E'\tAbc\t', 'abc'),
    (2, E'\n Foo Bar \n', 'foo bar'),
    (3, E'\r\f' || chr(11) || ' x ' || chr(11) || E'\f\r', 'x'),
    (4, E'a\tb', 'a b'),
    (5, E'a \t\n\r\f' || chr(11) || ' b', 'a b'),
    (6, 'a' || chr(160) || 'b', 'a b'),
    (7, chr(160) || 'a' || chr(160) || ' ' || E'\t', 'a'),
    (8, 'a' || chr(12288) || chr(12288) || 'b', 'a b'),
    (9, chr(12288) || 'a' || chr(12288), 'a'),
    (10, chr(65279) || 'A', chr(65279) || 'a'),
    (11, 'a' || chr(65279) || 'b', 'a' || chr(65279) || 'b'),
    (12, 'a' || chr(8232) || 'b', 'a' || chr(8232) || 'b'),
    (13, 'a' || chr(8233) || 'b', 'a' || chr(8233) || 'b'),
    (14, 'a' || chr(5760) || 'b', 'a' || chr(5760) || 'b'),
    (15, 'ＡＢＣ  Ｄ', 'abc d'),
    (16, '  여행   준비물 ', '여행 준비물')
  ) as t(n, input, want)
  loop
    if cf_norm_key(r.input) is distinct from r.want then
      raise exception 'FAIL: key row % (got %, want %)', r.n, encode(convert_to(cf_norm_key(r.input), 'UTF8'), 'hex'), encode(convert_to(r.want, 'UTF8'), 'hex');
    end if;
  end loop;
  raise notice 'PASS: the fixed character table gives the expected keys';
end $$;
select expect_count($$select count(*) from pg_proc where proname in ('enforce_keyword_trend_cap', 'enforce_blog_metric_cap') and prosrc like '%pg_advisory_xact_lock%'$$, 2, 'both caps count under an advisory lock');
select as_user('00000000-0000-0000-0000-0000000000a1'); -- authenticated
select expect_error($$select assert_blog_active('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1')$$, 'permission denied', 'authenticated can not call assert_blog_active directly');
reset role;
select expect_count($$select count(*) from (select 1 where has_function_privilege('anon', 'assert_blog_active(uuid, uuid)', 'execute') or has_function_privilege('authenticated', 'assert_blog_active(uuid, uuid)', 'execute')) x$$, 0, 'neither anon nor authenticated holds execute on assert_blog_active');

-- the stored key columns follow the same rule
select as_user('00000000-0000-0000-0000-0000000000a1'); -- ownerA
select ins_trend('10000000-0000-0000-0000-00000000000a', null, E'\t탭\t키워드\n', '표', '2026-11-03', '00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from keyword_trends where keyword_key = '탭 키워드'$$, 1, 'tabs and line breaks give the same trend key as spaces');
select ins_trend('10000000-0000-0000-0000-00000000000a', null, '탭 키워드', '표', '2026-11-03', '00000000-0000-0000-0000-0000000000a1', '5');
select ins_trend('10000000-0000-0000-0000-00000000000a', null, '탭' || chr(160) || chr(12288) || '키워드', '표', '2026-11-03', '00000000-0000-0000-0000-0000000000a1', '5');
select expect_count($$select count(*) from keyword_trends where keyword_key = '탭 키워드'$$, 1, 'NBSP and ideographic space duplicates are skipped');
select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'gsc', '클릭수', 'query', E'탭\t질의', '2026-11-03', '00000000-0000-0000-0000-0000000000a1');
select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'gsc', E'클릭수\n', 'query', '탭 질의', '2026-11-03', '00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from blog_metric_snapshots where scope = 'query' and dimension_key = md5('탭 질의') and measured_on = '2026-11-03'$$, 1, 'a tab inside a query and a trailing line break in a metric are the same measurement');
insert into blog_metric_snapshots (workspace_id, tool, metric, value, measured_on, evidence_url, created_by) values ('10000000-0000-0000-0000-00000000000a', 'other', 'url', 1, '2026-11-03', 'HTTPS://a.example/x', '00000000-0000-0000-0000-0000000000a1');
select expect_count($$select count(*) from blog_metric_snapshots where evidence_url = 'HTTPS://a.example/x'$$, 1, 'an upper-case scheme passes the evidence URL check');
select expect_error($$insert into blog_metric_snapshots (workspace_id, tool, metric, value, measured_on, evidence_url, created_by) values ('10000000-0000-0000-0000-00000000000a', 'other', 'url2', 1, '2026-11-03', 'JavaScript:alert(1)', '00000000-0000-0000-0000-0000000000a1')$$, 'evidence_url_check', 'a mixed-case javascript scheme is still rejected');

-- archived accounts: no new link, no new record; existing values stay
reset role;
insert into blogs (id, workspace_id, platform, domain, display_name, status) values
  ('20000000-0000-0000-0000-0000000000a3', '10000000-0000-0000-0000-00000000000a', 'naver', 'old.naver.com', '보관 블로그', 'archived'),
  ('20000000-0000-0000-0000-0000000000a4', '10000000-0000-0000-0000-00000000000a', 'naver', 'soon.naver.com', '곧 보관', 'active');
insert into keywords (id, workspace_id, phrase, created_by, blog_id) values
  ('50000000-0000-0000-0000-0000000000c4', '10000000-0000-0000-0000-00000000000a', '곧 보관될 키워드', '00000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000a4');
select ins_trend('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a4', '보관 전 기록', '표', '2026-11-04', '00000000-0000-0000-0000-0000000000a1');
select ins_metric('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a4', 'bseupi', '보관 전 지수', 'site', '', '2026-11-04', '00000000-0000-0000-0000-0000000000a1');
update articles set blog_id = '20000000-0000-0000-0000-0000000000a4' where id = '30000000-0000-0000-0000-000000000104';
update blogs set status = 'archived' where id = '20000000-0000-0000-0000-0000000000a4';

select as_user('00000000-0000-0000-0000-0000000000a1'); -- ownerA
select expect_error($$insert into keywords (workspace_id, phrase, created_by, blog_id) values ('10000000-0000-0000-0000-00000000000a', '보관 연결', '00000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000a3')$$, 'archived', 'a new keyword can not link to an archived blog');
select expect_error($$update keywords set blog_id = '20000000-0000-0000-0000-0000000000a3' where id = '50000000-0000-0000-0000-0000000000b1'$$, 'archived', 'a keyword can not be moved to an archived blog');
update keywords set note = '메모', blog_id = '20000000-0000-0000-0000-0000000000a4' where id = '50000000-0000-0000-0000-0000000000c4';
select expect_count($$select count(*) from keywords where id = '50000000-0000-0000-0000-0000000000c4' and note = '메모' and blog_id = '20000000-0000-0000-0000-0000000000a4'$$, 1, 'a keyword keeps its archived blog when other columns change');
select expect_error($$update articles set blog_id = '20000000-0000-0000-0000-0000000000a3' where id = '30000000-0000-0000-0000-000000000104'$$, 'archived', 'an article can not be moved to an archived blog');
update articles set blog_id = '20000000-0000-0000-0000-0000000000a4' where id = '30000000-0000-0000-0000-000000000104';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-000000000104' and blog_id = '20000000-0000-0000-0000-0000000000a4'$$, 1, 'an article keeps an archived blog when the same value is written');
select expect_error($$insert into articles (workspace_id, owner_id, blog_id) values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000a3')$$, 'archived', 'a new article can not start in an archived blog');
select expect_error($$select ins_trend('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a3', '새 기록', '표', '2026-11-04', '00000000-0000-0000-0000-0000000000a1')$$, 'archived', 'a new trend row is refused for an archived blog');
select ins_trend('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a4', '보관 전 기록', '표', '2026-11-04', '00000000-0000-0000-0000-0000000000a1', '777');
select expect_count($$select count(*) from keyword_trends where keyword = '보관 전 기록' and monthly_searches = 100$$, 1, 're-inserting an existing trend row of an archived blog is ignored');
select expect_error($$select ins_trend('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a4', '보관 후 기록', '표', '2026-11-04', '00000000-0000-0000-0000-0000000000a1')$$, 'archived', 'a new key under an archived blog is refused');
select expect_error($$select ins_metric('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a3', 'other', '새 지표', 'site', '', '2026-11-04', '00000000-0000-0000-0000-0000000000a1')$$, 'archived', 'a new record is refused for an archived blog');
select ins_metric('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a4', 'bseupi', '보관 전 지수', 'site', '', '2026-11-04', '00000000-0000-0000-0000-0000000000a1', '999');
select expect_count($$select count(*) from blog_metric_snapshots where metric = '보관 전 지수' and value = 10$$, 1, 're-inserting an existing record of an archived blog is ignored');
select expect_count($$select count(*) from keyword_trends where blog_id = '20000000-0000-0000-0000-0000000000a4'$$, 1, 'records of an archived blog stay readable');
-- an editor can not lock blog rows directly, so the check must not need it
select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
select expect_error($$select ins_trend('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a3', '편집자 보관', '표', '2026-11-04', '00000000-0000-0000-0000-0000000000a2')$$, 'archived', 'an editor also gets the archived message');
select ins_trend('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a2', '편집자 활성', '표', '2026-11-04', '00000000-0000-0000-0000-0000000000a2');
select expect_count($$select count(*) from keyword_trends where keyword = '편집자 활성'$$, 1, 'an editor can still record for an active blog');

-- limits: a full workspace still ignores duplicates and refuses new rows
reset role;
alter table keyword_trends disable trigger keyword_trends_cap;
insert into keyword_trends (workspace_id, keyword, category, monthly_searches, source, measured_on, created_by)
  select '10000000-0000-0000-0000-00000000000a', 'fill-' || g, 'IT', 1, 'fill', date '2026-01-01', '00000000-0000-0000-0000-0000000000a1'
  from generate_series(1, 20000 - (select count(*)::int from keyword_trends where workspace_id = '10000000-0000-0000-0000-00000000000a')) g;
alter table keyword_trends enable trigger keyword_trends_cap;
alter table blog_metric_snapshots disable trigger blog_metric_snapshots_cap;
insert into blog_metric_snapshots (workspace_id, tool, metric, value, measured_on, created_by)
  select '10000000-0000-0000-0000-00000000000a', 'other', 'fill-' || g, 1, date '2026-01-01', '00000000-0000-0000-0000-0000000000a1'
  from generate_series(1, 30000 - (select count(*)::int from blog_metric_snapshots where workspace_id = '10000000-0000-0000-0000-00000000000a')) g;
alter table blog_metric_snapshots enable trigger blog_metric_snapshots_cap;
select expect_count($$select count(*) from keyword_trends where workspace_id = '10000000-0000-0000-0000-00000000000a'$$, 20000, 'the trend table is full');
select expect_count($$select count(*) from blog_metric_snapshots where workspace_id = '10000000-0000-0000-0000-00000000000a'$$, 30000, 'the record table is full');

select as_user('00000000-0000-0000-0000-0000000000a1'); -- ownerA
select ins_trend('10000000-0000-0000-0000-00000000000a', null, ' FILL-1 ', 'fill', '2026-01-01', '00000000-0000-0000-0000-0000000000a1', '5');
select expect_count($$select count(*) from keyword_trends where workspace_id = '10000000-0000-0000-0000-00000000000a'$$, 20000, 'a duplicate trend row passes a full workspace and adds nothing');
select expect_error($$select ins_trend('10000000-0000-0000-0000-00000000000a', null, '초과 키워드', 'fill', '2026-01-01', '00000000-0000-0000-0000-0000000000a1')$$, 'keyword trend limit reached \(20000 per workspace\)', 'a new trend row over the limit is refused');
select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'other', ' FILL-1 ', 'site', '', '2026-01-01', '00000000-0000-0000-0000-0000000000a1', '5');
select expect_count($$select count(*) from blog_metric_snapshots where workspace_id = '10000000-0000-0000-0000-00000000000a'$$, 30000, 'a duplicate record passes a full workspace and adds nothing');
select expect_error($$select ins_metric('10000000-0000-0000-0000-00000000000a', null, 'other', '초과 지표', 'site', '', '2026-01-01', '00000000-0000-0000-0000-0000000000a1')$$, 'blog metric limit reached \(30000 per workspace\)', 'a new record over the limit is refused');
reset role;
delete from keyword_trends where source = 'fill';
delete from blog_metric_snapshots where metric like 'fill-%';

-- the lifecycle function itself agrees with the table
reset role;
select expect_count($$select count(*) from unnest(enum_range(null::article_state)) s where article_transition_allowed(s, s)$$, 0, 'no state transitions to itself');
select 'ALL RLS CHECKS PASSED' as result;
