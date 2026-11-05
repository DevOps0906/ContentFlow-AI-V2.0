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

update articles set state = 'approved' where id = '30000000-0000-0000-0000-0000000000a2';
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
update articles set state = 'approved' where id = '30000000-0000-0000-0000-0000000000a2';
select expect_count($$select count(*) from article_versions where article_id = '30000000-0000-0000-0000-0000000000a2' and version = 2$$, 1, 're-approval writes snapshot v2');

-- delivery chain
update articles set state = 'export_ready' where id = '30000000-0000-0000-0000-0000000000a2';
update articles set state = 'publishing' where id = '30000000-0000-0000-0000-0000000000a2';
select expect_fail($$update articles set state = 'published' where id = '30000000-0000-0000-0000-0000000000a2'$$,
  'publishing → published needs an operator confirmation step');
update articles set state = 'draft_created', remote = '{"postId":7,"url":"https://x/?p=7"}'
  where id = '30000000-0000-0000-0000-0000000000a2';
update articles set state = 'published' where id = '30000000-0000-0000-0000-0000000000a2';
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
update articles set state = 'approved' where id = '30000000-0000-0000-0000-0000000000a3';
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
insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, page, revenue, pageviews, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'adsense|estimated|KRW|2026-11-01|', 'AdSense', 'estimated', 'KRW', '2026-11-01', '', 1000.5, 500, '00000000-0000-0000-0000-0000000000a1');
select expect_fail($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'adsense|estimated|KRW|2026-11-01|', 'AdSense', 'estimated', 'KRW', '2026-11-01', 5, '00000000-0000-0000-0000-0000000000a1')$$,
  'the same report row can not be stored twice');
select expect_fail($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'k2', 'AdSense', 'estimated', 'KRW', '2026-11-01', -1, '00000000-0000-0000-0000-0000000000a1')$$, 'negative revenue rejected');
select expect_fail($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'k3', 'AdSense', 'maybe', 'KRW', '2026-11-01', 1, '00000000-0000-0000-0000-0000000000a1')$$, 'unknown status rejected');
select expect_fail($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'k4', 'AdSense', 'estimated', 'won', '2026-11-01', 1, '00000000-0000-0000-0000-0000000000a1')$$, 'bad currency rejected');
select expect_fail($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'k5', 'AdSense', 'estimated', 'KRW', '2026-11-01', '00000000-0000-0000-0000-0000000000a1')$$, 'a row with no values at all is rejected');
select expect_fail($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000b', 'k6', 'AdSense', 'estimated', 'KRW', '2026-11-01', 1, '00000000-0000-0000-0000-0000000000a1')$$, 'ownerA can not write revenue into workspace B');
select as_user('00000000-0000-0000-0000-0000000000a2'); -- editorA
select expect_count($$select count(*) from revenue_rows$$, 1, 'members can read revenue');
select expect_fail($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'k7', 'AdSense', 'estimated', 'KRW', '2026-11-01', 1, '00000000-0000-0000-0000-0000000000a2')$$, 'editor can not import revenue (owner/admin only)');
delete from revenue_rows;
select expect_count($$select count(*) from revenue_rows$$, 1, 'editor can not delete revenue');
select as_user('00000000-0000-0000-0000-0000000000b1');
select expect_count($$select count(*) from revenue_rows$$, 0, 'workspace B sees no revenue of A');
reset role;
insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, revenue, created_by)
  select '10000000-0000-0000-0000-00000000000a', 'bulk' || g, 'S', 'estimated', 'KRW', '2026-11-01', 1, '00000000-0000-0000-0000-0000000000a1' from generate_series(1, 19999) g;
select expect_fail($$insert into revenue_rows (workspace_id, row_key, source, status, currency, report_date, revenue, created_by)
  values ('10000000-0000-0000-0000-00000000000a', 'over', 'S', 'estimated', 'KRW', '2026-11-01', 1, '00000000-0000-0000-0000-0000000000a1')$$, '20000 revenue row cap enforced by the database');
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
-- the lifecycle function itself agrees with the table
reset role;
select expect_count($$select count(*) from unnest(enum_range(null::article_state)) s where article_transition_allowed(s, s)$$, 0, 'no state transitions to itself');
select 'ALL RLS CHECKS PASSED' as result;
