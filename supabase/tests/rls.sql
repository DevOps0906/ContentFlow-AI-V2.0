-- RLS acceptance test. Run against a plain Postgres: stubs Supabase's auth schema.
-- Usage: see supabase/tests/run.ps1. Any failed assertion raises and aborts (ON_ERROR_STOP).

create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create role authenticated nologin;
grant usage on schema public, auth to authenticated;

\ir ../migrations/0001_core_tenancy.sql
\ir ../migrations/0002_article_content_and_state_rules.sql

grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage on all sequences in schema public to authenticated;

insert into auth.users values
  ('00000000-0000-0000-0000-0000000000a1'), -- ownerA
  ('00000000-0000-0000-0000-0000000000a2'), -- editorA
  ('00000000-0000-0000-0000-0000000000a3'), -- viewerA
  ('00000000-0000-0000-0000-0000000000a4'), -- reviewerA
  ('00000000-0000-0000-0000-0000000000b1'); -- ownerB

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
insert into memberships values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', 'editor'),
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3', 'viewer'),
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a4', 'reviewer');
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
update articles set title = 'x' where id = '30000000-0000-0000-0000-0000000000a3';
select expect_count($$select count(*) from articles where id = '30000000-0000-0000-0000-0000000000a3' and title = 'T'$$, 1, 'reviewer can not edit content (RLS hides the row)');

-- the lifecycle function itself agrees with the table
reset role;
select expect_count($$select count(*) from unnest(enum_range(null::article_state)) s where article_transition_allowed(s, s)$$, 0, 'no state transitions to itself');
select 'ALL RLS CHECKS PASSED' as result;
