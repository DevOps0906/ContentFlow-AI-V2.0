-- 합성 데이터(실데이터 아님): 옛 public 스키마(0001~0027)에 사용자 2명(익명 0명), 표마다 2~3행.
-- 유료 플랜(basic·pro)·1인 workspace·reviewer 멤버·대기/수락 초대·보관(archived) 블로그·멱등 키·동기화 행 포함.
-- 옛 업무 트리거(상태 규칙·해시·번호)는 이 검사의 대상이 아니므로 replica 모드로 넣는다(FK는 직접 맞춘다).
begin;
set local session_replication_role = replica;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000a1', 'alice@example.com', now(), '{"name":"Alice"}'),
  ('00000000-0000-4000-8000-0000000000b2', 'bob@example.com', now(), '{}');

-- W1: alice 소유 basic, bob은 reviewer / W2: bob 1인 free / W3: alice 1인 pro
insert into public.workspaces (id, name, owner_id, plan, created_at) values
  ('10000000-0000-4000-8000-000000000001', '새봄 블로그팀', '00000000-0000-4000-8000-0000000000a1', 'basic', '2026-01-01 09:00+09'),
  ('10000000-0000-4000-8000-000000000002', 'Bob 개인', '00000000-0000-4000-8000-0000000000b2', 'free', '2026-02-01 09:00+09'),
  ('10000000-0000-4000-8000-000000000003', '한울 미디어', '00000000-0000-4000-8000-0000000000a1', 'pro', '2026-03-01 09:00+09');
insert into public.memberships (workspace_id, user_id, role, created_at) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'owner', '2026-01-01 09:00+09'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000b2', 'reviewer', '2026-01-05 09:00+09'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000b2', 'owner', '2026-02-01 09:00+09'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000a1', 'owner', '2026-03-01 09:00+09');
insert into public.workspace_entitlements (workspace_id, plan, included_blogs, max_blogs, overage_allowed, grace_until, updated_at) values
  ('10000000-0000-4000-8000-000000000001', 'basic', 3, 10, true, '2026-02-01', '2026-01-10 09:00+09'),
  ('10000000-0000-4000-8000-000000000002', 'free', 1, 1, false, null, '2026-02-01 09:00+09'),
  ('10000000-0000-4000-8000-000000000003', 'pro', 10, 30, true, null, '2026-03-01 09:00+09');
insert into public.invitations (id, workspace_id, email, role, invited_by, created_at, accepted_at) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Carol@Example.com', 'editor', '00000000-0000-4000-8000-0000000000a1', '2026-01-20 09:00+09', null),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'bob@example.com', 'reviewer', '00000000-0000-4000-8000-0000000000a1', '2026-01-04 09:00+09', '2026-01-05 09:00+09'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'dave@example.com', 'reviewer', '00000000-0000-4000-8000-0000000000a1', '2026-03-02 09:00+09', null);

insert into public.blogs (id, workspace_id, platform, domain, status, display_name, created_at) values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'wordpress', 'saebom.example.com', 'active', '새봄', '2026-01-02 09:00+09'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'tistory', 'old.example.com', 'archived', null, '2026-01-03 09:00+09'),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'naver', 'bob.example.com', 'active', 'Bob', '2026-02-02 09:00+09');
insert into public.sources (id, workspace_id, url, title, checked_at, license_note) values
  ('31000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'https://src.example.com/a', '출처 A', '2026-01-04 09:00+09', 'CC BY'),
  ('31000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'https://src.example.com/b', null, null, null);
insert into public.keywords (id, workspace_id, phrase, intent, priority, note, created_by, created_at, blog_id) values
  ('32000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '봄 여행', 'info', 2, '', '00000000-0000-4000-8000-0000000000a1', '2026-01-04 09:00+09', '30000000-0000-4000-8000-000000000001'),
  ('32000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '캠핑 장비', '', 3, '메모', '00000000-0000-4000-8000-0000000000b2', '2026-02-04 09:00+09', null);
insert into public.articles (id, workspace_id, owner_id, blog_id, keyword_id, state, created_at, updated_at, title, keyword, template_id, template_version, platform, body, source_url, remote, published_url, layout_profile, ad_profile, renderer_version, brief_purpose, brief_audience, evidence_status, rights_status) values
  ('33000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000001', 'published', '2026-01-05 09:00+09', '2026-01-09 18:30+09', '봄 여행 가이드', '봄 여행', 'T01', 'T01@2', 'wordpress', '# 본문', 'https://src.example.com/a', '{"postId": 11, "url": "https://saebom.example.com/?p=11"}', 'https://saebom.example.com/spring', 'L01', 'A01', 'r3', '여행 정보', '20대', 'ok', 'ok'),
  ('33000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', null, null, 'idea', '2026-01-06 09:00+09', '2026-01-06 09:00+09', '', '', 'T01', null, 'wordpress', '', '', null, null, 'L01', 'A00', null, '', '', 'unreviewed', 'unreviewed'),
  ('33000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000b2', '30000000-0000-4000-8000-000000000003', null, 'drafting', '2026-02-05 09:00+09', '2026-02-07 10:00+09', '캠핑', '캠핑 장비', 'T02', null, 'naver', '초안', '', null, null, 'L02', 'A00', null, '', '', 'unreviewed', 'unreviewed');
insert into public.article_versions (id, workspace_id, article_id, version, title, markdown, source_id, content_hash, created_by, created_at, source_url, template_id, platform, layout_profile, ad_profile, renderer_version, hash_version, template_version) values
  ('34000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001', 1, '봄 여행', '# v1', '31000000-0000-4000-8000-000000000001', 'hash-v1', '00000000-0000-4000-8000-0000000000a1', '2026-01-07 09:00+09', 'https://src.example.com/a', 'T01', 'wordpress', 'L01', 'A01', 'r3', 2, 'T01@2'),
  ('34000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001', 2, '봄 여행 가이드', '# v2', null, 'hash-v2', '00000000-0000-4000-8000-0000000000a1', '2026-01-08 09:00+09', null, null, null, null, null, null, null, null);
insert into public.approvals (id, workspace_id, article_version_id, reviewer_id, decision, snapshot_hash, decided_at) values
  ('35000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '34000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000b2', 'rejected', 'hash-v1', '2026-01-07 12:00+09'),
  ('35000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '34000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000b2', 'approved', 'hash-v2', '2026-01-08 12:00+09');
insert into public.audit_logs (workspace_id, actor_id, action, payload, created_at) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'article.create', '{"id": "33000000-0000-4000-8000-000000000001"}', '2026-01-05 09:00+09'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000b2', 'article.approve', '{}', '2026-01-08 12:00+09'),
  ('10000000-0000-4000-8000-000000000002', null, 'blog.overage_ack', '{"blog": "x"}', '2026-02-02 09:00+09');
-- 지워진 감사 행이 있던 것처럼 id 사이에 빈칸(시퀀스 setval 확인)
delete from public.audit_logs where action = 'article.approve';
insert into public.audit_logs (workspace_id, actor_id, action, payload, created_at) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000b2', 'article.approve', '{}', '2026-01-08 12:00+09');

insert into public.analytics_credentials (grant_id, workspace_id, google_sub, client_id, ciphertext, key_version, created_by, created_at, updated_at) values
  ('36000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'google-sub-1', 'client-1', 'v1:synthetic-ciphertext', 1, '00000000-0000-4000-8000-0000000000a1', '2026-01-10 09:00+09', '2026-01-11 09:00+09');
insert into public.analytics_connections (id, workspace_id, blog_id, grant_id, provider, external_ref, scopes, status, connected_by, last_attempt_at, last_success_at, last_error_code, created_at) values
  ('37000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '36000000-0000-4000-8000-000000000001', 'gsc', 'sc-domain:saebom.example.com', '{https://www.googleapis.com/auth/webmasters.readonly}', 'active', '00000000-0000-4000-8000-0000000000a1', '2026-01-12 09:00+09', '2026-01-12 09:00+09', null, '2026-01-10 09:00+09'),
  ('37000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', null, null, 'adsense', 'pub-0000', '{}', 'revoked', '00000000-0000-4000-8000-0000000000a1', null, null, 'revoked', '2026-01-10 10:00+09');
insert into public.analytics_sync_runs (id, connection_id, workspace_id, requested_by, range_start, range_end, requested_at, status, rows_written, error_code, started_at, finished_at) values
  ('38000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', '2026-01-01', '2026-01-10', '2026-01-12 09:00+09', 'succeeded', 1, null, '2026-01-12 09:00+09', '2026-01-12 09:01+09'),
  ('38000000-0000-4000-8000-000000000002', '37000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', '2026-01-11', '2026-01-11', '2026-01-13 09:00+09', 'failed', 0, 'quota', '2026-01-13 09:00+09', '2026-01-13 09:00+09');
insert into public.revenue_rows (id, workspace_id, row_key, source, status, currency, report_date, page, revenue, pageviews, impressions, clicks, created_by, created_at, timezone, period_start, period_end, coverage, sync_run_id, connection_id) values
  ('39000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'adsense|2026-01-05|/spring', 'adsense', 'finalized', 'KRW', '2026-01-05', '/spring', 1234.5678, 100, 1000, 7, '00000000-0000-4000-8000-0000000000a1', '2026-01-06 09:00+09', 'Asia/Seoul', '2026-01-01', '2026-01-31', 'complete', null, null),
  ('39000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'gsc-api|2026-01-05', 'gsc-api', 'estimated', 'USD', '2026-01-05', '', null, 50, 500, 5, '00000000-0000-4000-8000-0000000000a1', '2026-01-12 09:01+09', 'UTC', '2026-01-01', '2026-01-10', 'partial', '38000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000001'),
  ('39000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'manual|2026-02-01', 'manual', 'estimated', 'KRW', '2026-02-01', '', 300, null, null, null, '00000000-0000-4000-8000-0000000000b2', '2026-02-02 09:00+09', 'Asia/Seoul', '2026-02-01', '2026-02-28', 'complete', null, null);
insert into public.blog_metric_snapshots (id, workspace_id, blog_id, tool, metric, scope, dimension, value, value_label, unit, measured_on, evidence_url, memo, created_by, created_at, coverage, sync_run_id, connection_id) values
  ('3a000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'gsc-api', 'clicks', 'query', '봄 여행', 12, null, '', '2026-01-10', null, '', '00000000-0000-4000-8000-0000000000a1', '2026-01-12 09:01+09', 'complete', '38000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000001'),
  ('3a000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', null, 'blackkiwi', 'grade', 'site', '', null, '준최3', '', '2026-02-10', 'https://kiwi.example.com/r/1', '수동', '00000000-0000-4000-8000-0000000000b2', '2026-02-10 09:00+09', 'complete', null, null);
insert into public.keyword_trends (id, workspace_id, blog_id, keyword, category, monthly_searches, growth_pct, document_count, source, measured_on, created_by, created_at) values
  ('3b000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '봄 여행', '여행', 12000, 12.5, 3400, 'naver', '2026-01-04', '00000000-0000-4000-8000-0000000000a1', '2026-01-04 09:00+09'),
  ('3b000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', null, '캠핑', '', null, -3, null, 'blackkiwi', '2026-02-04', '00000000-0000-4000-8000-0000000000b2', '2026-02-04 09:00+09');
insert into public.agent_runs (id, workspace_id, task, model, prompt_version, status, tokens_in, tokens_out, duration_ms, cost_estimate, cost_currency, created_by, created_at) values
  ('3c000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'draft', 'model-x', 'p1', 'succeeded', 1000, 2000, 3500, 0.0123, 'USD', '00000000-0000-4000-8000-0000000000a1', '2026-01-05 10:00+09'),
  ('3c000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'review', 'model-y', 'p2', 'timeout', null, null, 60000, null, null, '00000000-0000-4000-8000-0000000000b2', '2026-02-05 10:00+09');
insert into public.article_state_events (id, workspace_id, article_id, from_state, to_state, actor_id, created_at) values
  ('3d000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001', 'approved', 'published', '00000000-0000-4000-8000-0000000000a1', '2026-01-09 18:30+09'),
  ('3d000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '33000000-0000-4000-8000-000000000003', 'idea', 'drafting', null, '2026-02-07 10:00+09');
insert into public.delivery_attempts (id, workspace_id, article_id, channel, attempt, failure_type, url, duration_ms, created_by, created_at) values
  ('3e000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001', 'wordpress', 1, 'timeout', null, 30000, '00000000-0000-4000-8000-0000000000a1', '2026-01-09 18:00+09'),
  ('3e000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001', 'wordpress', 2, null, 'https://saebom.example.com/?p=11', 1200, '00000000-0000-4000-8000-0000000000a1', '2026-01-09 18:30+09');
insert into public.site_checks (id, workspace_id, check_key, status, evidence_url, note, checked_by, checked_at) values
  ('3f000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ads_txt', 'pass', 'https://saebom.example.com/ads.txt', null, '00000000-0000-4000-8000-0000000000a1', '2026-01-15 09:00+09'),
  ('3f000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ad_status', 'unknown', null, null, '00000000-0000-4000-8000-0000000000b2', '2026-02-15 09:00+09');
insert into public.cost_entries (id, workspace_id, category, amount, currency, occurred_on, provenance, note, created_by, created_at) values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'hosting', 15000, 'KRW', '2026-01-31', 'manual', '서버', '00000000-0000-4000-8000-0000000000a1', '2026-01-31 09:00+09'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'model', 1.25, 'USD', '2026-02-28', 'manual', null, '00000000-0000-4000-8000-0000000000b2', '2026-02-28 09:00+09');
insert into public.improvement_tasks (id, workspace_id, article_id, target_url, evidence, observed_from, observed_to, assignee_id, review_at, state, result_version, created_by, created_at, updated_at) values
  ('41000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001', 'https://saebom.example.com/spring', 'CTR 하락', '2026-01-10', '2026-01-20', '00000000-0000-4000-8000-0000000000b2', '2026-02-01', 'done', 2, '00000000-0000-4000-8000-0000000000a1', '2026-01-21 09:00+09', '2026-01-25 09:00+09'),
  ('41000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001', 'https://saebom.example.com/spring', '제목 개선', '2026-01-21', '2026-01-28', null, '2026-02-10', 'open', null, '00000000-0000-4000-8000-0000000000a1', '2026-01-29 09:00+09', '2026-01-29 09:00+09');
insert into public.blog_usage_snapshots (workspace_id, period_start, period_end, peak_active, active_at_close, overage_slots, created_at) values
  ('10000000-0000-4000-8000-000000000001', '2026-01-01', '2026-02-01', 2, 1, 0, '2026-02-01 00:00+09'),
  ('10000000-0000-4000-8000-000000000002', '2026-02-01', '2026-03-01', 1, 1, 0, '2026-03-01 00:00+09');
insert into public.publish_jobs (id, workspace_id, article_id, approved_version_id, channel, remote_key, idempotency_key, status, attempts, max_attempts, next_attempt_at, locked_at, locked_by, last_error, cancel_reason, created_by, created_at, updated_at) values
  ('42000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001', '34000000-0000-4000-8000-000000000002', 'wordpress', 'saebom.example.com', 'idem-0001', 'succeeded', 2, 6, '2026-01-09 18:00+09', null, null, null, null, '00000000-0000-4000-8000-0000000000a1', '2026-01-09 17:59+09', '2026-01-09 18:30+09'),
  ('42000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001', '34000000-0000-4000-8000-000000000001', 'wordpress', 'saebom.example.com', 'idem-0002', 'cancelled', 0, 6, '2026-01-08 18:00+09', null, null, null, 'superseded', '00000000-0000-4000-8000-0000000000a1', '2026-01-08 17:59+09', '2026-01-08 18:10+09');
insert into public.rate_limits (key, window_start, hits) values
  ('ai:00000000-0000-4000-8000-0000000000a1', '2026-01-05 10:00+09', 3),
  ('login:203.0.113.7', '2026-01-05 10:00+09', 1);

commit;
