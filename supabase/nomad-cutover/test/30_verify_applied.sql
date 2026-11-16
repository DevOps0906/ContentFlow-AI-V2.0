-- 02_copy.sql 적용 뒤 값·RLS 격리 확인(합성 데이터 기준). 끝에서 rollback.
\set ON_ERROR_STOP on
begin;

do $$
declare
  a1 constant uuid := '00000000-0000-4000-8000-0000000000a1';
  b2 constant uuid := '00000000-0000-4000-8000-0000000000b2';
  w1 constant uuid := '10000000-0000-4000-8000-000000000001';
  w2 constant uuid := '10000000-0000-4000-8000-000000000002';
  w3 constant uuid := '10000000-0000-4000-8000-000000000003';
  v text;
begin
  -- set local은 02 트랜잭션 안에서만: 새 세션은 origin
  if current_setting('session_replication_role') <> 'origin' then
    raise exception 'VERIFY: session_replication_role이 %로 남았다', current_setting('session_replication_role');
  end if;

  -- workspace = 같은 id의 team 조직(1인 workspace W2·W3도 team), created_by = owner
  if (select count(*) from nomad_core.organizations where id in (w1, w2, w3) and kind = 'team' and active and seat_limit is null) <> 3 then
    raise exception 'VERIFY: team 조직 3개가 아니다';
  end if;
  if (select created_by from nomad_core.organizations where id = w2) <> b2 then raise exception 'VERIFY: W2 created_by'; end if;
  if (select count(*) from nomad_core.memberships where organization_id = w2) <> 1 then raise exception 'VERIFY: W2 1인 멤버'; end if;

  -- reviewer → viewer + reviewers
  if (select role from nomad_core.memberships where organization_id = w1 and user_id = b2) <> 'viewer' then
    raise exception 'VERIFY: reviewer가 viewer로 안 바뀜';
  end if;
  if not exists (select 1 from nomad_contentflow.reviewers where organization_id = w1 and user_id = b2
                 and created_at = '2026-01-05 09:00+09') then
    raise exception 'VERIFY: reviewers 행 없음';
  end if;

  -- 개인 조직(db push 백필)은 그대로, 사용자마다 1개
  if (select count(*) from nomad_core.organizations o join nomad_core.memberships m on m.organization_id = o.id
      where o.kind = 'personal' and m.user_id in (a1, b2)) <> 2 then
    raise exception 'VERIFY: 개인 조직 2개가 아니다';
  end if;

  -- 플랜 → 구독
  select string_agg(organization_id::text || '=' || plan_code, ',' order by organization_id) into v
  from nomad_core.subscriptions where product_code = 'contentflow' and status = 'active';
  if v <> w1::text || '=B,' || w2::text || '=C,' || w3::text || '=A' then raise exception 'VERIFY: 구독 %', v; end if;

  -- 대기 초대만, 이메일 소문자, reviewer 초대는 viewer, 새 token, 7일 만료
  select string_agg(email || ':' || role, ',' order by email) into v
  from nomad_core.invitations where organization_id in (w1, w3);
  if v <> 'carol@example.com:editor,dave@example.com:viewer' then raise exception 'VERIFY: 초대 %', v; end if;
  if exists (select 1 from nomad_core.invitations where organization_id in (w1, w3)
             and (length(token) <> 64 or expires_at < now() + interval '6 days')) then
    raise exception 'VERIFY: 초대 token·만료';
  end if;

  -- 원본 값 유지(트리거가 꺼졌다는 증거): updated_at·번호·감사 id·시퀀스
  if (select updated_at from nomad_contentflow.articles where id = '33000000-0000-4000-8000-000000000001') <> '2026-01-09 18:30+09' then
    raise exception 'VERIFY: articles.updated_at이 바뀌었다';
  end if;
  if (select string_agg(attempt::text, ',' order by attempt) from nomad_contentflow.delivery_attempts) <> '1,2' then
    raise exception 'VERIFY: delivery_attempts 번호';
  end if;
  if (select string_agg(id::text, ',' order by id) from nomad_contentflow.audit_logs) <> '1,3,4' then
    raise exception 'VERIFY: audit_logs id';
  end if;
  if (select s.last_value from pg_sequences s where format('%I.%I', s.schemaname, s.sequencename)::regclass = pg_get_serial_sequence('nomad_contentflow.audit_logs', 'id')::regclass) <> 4 then
    raise exception 'VERIFY: audit_logs 시퀀스 setval';
  end if;
  if exists (select 1 from nomad_contentflow.blogs where updated_at <> created_at or deleted_at is not null) then
    raise exception 'VERIFY: blogs updated_at·deleted_at';
  end if;
  if (select status from nomad_contentflow.blogs where id = '30000000-0000-4000-8000-000000000002') <> 'archived' then
    raise exception 'VERIFY: 보관 블로그 상태';
  end if;
  if (select count(*) from nomad_contentflow.publish_jobs where idempotency_key in ('idem-0001', 'idem-0002')) <> 2 then
    raise exception 'VERIFY: 멱등 키';
  end if;
end $$;

-- 옮긴 뒤 시퀀스가 이어진다(새 감사 행 id = 5)
insert into nomad_contentflow.audit_logs (organization_id, action) values ('10000000-0000-4000-8000-000000000001', 'verify.seq');
do $$ begin
  if (select max(id) from nomad_contentflow.audit_logs) <> 5 then raise exception 'VERIFY: 새 감사 id'; end if;
end $$;

-- RLS 격리: alice는 W2(bob 1인) 행을 못 보고, bob은 W3(alice 1인)를 못 본다. bob은 W1을 viewer로 본다.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from nomad_contentflow.articles) <> 2
     or exists (select 1 from nomad_contentflow.articles where organization_id = '10000000-0000-4000-8000-000000000002')
     or exists (select 1 from nomad_contentflow.blogs where organization_id = '10000000-0000-4000-8000-000000000002')
     or exists (select 1 from nomad_contentflow.revenue_rows where organization_id = '10000000-0000-4000-8000-000000000002') then
    raise exception 'VERIFY RLS: alice가 W2를 본다';
  end if;
  -- 조직 목록: 개인 조직이 먼저(kind 순) → 앱은 마지막 사용 조직을 기본 선택(existing.md 앱 계약)
  if (select string_agg(kind, ',') from public.nomad_my_organizations()) <> 'personal,team,team' then
    raise exception 'VERIFY: alice 조직 목록 %', (select string_agg(kind, ',') from public.nomad_my_organizations());
  end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b2","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from nomad_contentflow.articles) <> 3
     or (select count(*) from nomad_contentflow.blogs where organization_id = '10000000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'VERIFY RLS: bob 범위가 다르다';
  end if;
  if exists (select 1 from public.nomad_my_organizations() where id = '10000000-0000-4000-8000-000000000003') then
    raise exception 'VERIFY RLS: bob이 W3 조직을 본다';
  end if;
  -- viewer(옛 reviewer)는 블로그를 못 고친다
  update nomad_contentflow.blogs set display_name = 'x' where organization_id = '10000000-0000-4000-8000-000000000001';
  if found then raise exception 'VERIFY RLS: viewer가 블로그를 고쳤다'; end if;
end $$;

rollback;
\echo VERIFY_APPLIED_OK
