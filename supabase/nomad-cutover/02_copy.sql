-- ContentFlow nomad DB 전환 2단계: 옛 public 데이터 → nomad_core(조직·멤버·구독·초대) + nomad_contentflow(제품 표). 한 트랜잭션.
-- 사용(기본 dry-run, 끝에서 rollback):  psql "<DB 주소(postgres)>" -v ON_ERROR_STOP=1 -f supabase/nomad-cutover/02_copy.sql
--      적용(commit):                    psql "<DB 주소(postgres)>" -v ON_ERROR_STOP=1 -v apply=1 -f supabase/nomad-cutover/02_copy.sql
-- 전제: 01_freeze.sql 적용 → db push(새 migrations, 백필이 사용자마다 개인 조직을 만든 상태) → contentflow 플랜 A/B/C·plan_limits 시드.
-- 대응 정본: nomad-supabase-module products/contentflow/existing.md "운영 데이터 이관".
--   workspace → team 조직(같은 id, created_by = owner_id) · 멤버 역할 그대로(reviewer → viewer + reviewers 행)
--   workspaces.plan → subscriptions(free→C, basic→B, pro→A) · 대기 초대만 새 token·7일 만료로 · 제품 표는 workspace_id → organization_id
-- 시작 검사(하나라도 걸리면 전부 모아 중단): 01 미적용, 대상 비어 있지 않음(재실행), 익명 사용자 소유 행, 대응 없는 플랜,
--   플랜·한도 시드 없음, 옛 이용권 값이 새 한도와 다름, 유예 중인 이용권, 개인 조직 없는 사용자, owner 멤버십 없는 workspace,
--   새 표 check 제약에 걸리는 옛 행(옛 NOT VALID 제약 등).
-- 복사는 session_replication_role = replica(set local)로 대상 트리거(상한·stamp·번호·잠금·FK)를 끄고 id·시각·번호를 원본 그대로 넣는다.
-- 끝 검사: 표마다 행 수 + 모든 옮긴 컬럼 값 대조(양방향 except all), FK 고아 행(복합 FK 포함) 0건 → 어긋나면 raise. 시퀀스 setval.
\set ON_ERROR_STOP on
\if :{?apply}
\else
\set apply 0
\endif

begin;
set local session_replication_role = replica;

-- 옛 값 → 새 값 대응(existing.md 표와 같아야 한다)
create temp table cf_plan_map (legacy_plan text primary key, plan_code text not null) on commit drop;
insert into cf_plan_map values ('free', 'C'), ('basic', 'B'), ('pro', 'A');

create temp table cf_role_map (legacy_role text primary key, role text not null, reviewer boolean not null) on commit drop;
insert into cf_role_map values
  ('owner', 'owner', false), ('admin', 'admin', false), ('editor', 'editor', false),
  ('reviewer', 'viewer', true), ('viewer', 'viewer', false);

-- 그대로 옮기는 제품 표(workspace_id → organization_id 외 같은 컬럼). workspaces·memberships·invitations·workspace_entitlements는 아래에서 따로.
create temp table cf_tables (ord int primary key, legacy regclass not null, target regclass not null) on commit drop;
insert into cf_tables values
  (1, 'public.blogs', 'nomad_contentflow.blogs'),
  (2, 'public.sources', 'nomad_contentflow.sources'),
  (3, 'public.keywords', 'nomad_contentflow.keywords'),
  (4, 'public.articles', 'nomad_contentflow.articles'),
  (5, 'public.article_versions', 'nomad_contentflow.article_versions'),
  (6, 'public.approvals', 'nomad_contentflow.approvals'),
  (7, 'public.audit_logs', 'nomad_contentflow.audit_logs'),
  (8, 'public.analytics_credentials', 'nomad_contentflow.analytics_credentials'),
  (9, 'public.analytics_connections', 'nomad_contentflow.analytics_connections'),
  (10, 'public.analytics_sync_runs', 'nomad_contentflow.analytics_sync_runs'),
  (11, 'public.revenue_rows', 'nomad_contentflow.revenue_rows'),
  (12, 'public.blog_metric_snapshots', 'nomad_contentflow.blog_metric_snapshots'),
  (13, 'public.keyword_trends', 'nomad_contentflow.keyword_trends'),
  (14, 'public.agent_runs', 'nomad_contentflow.agent_runs'),
  (15, 'public.article_state_events', 'nomad_contentflow.article_state_events'),
  (16, 'public.delivery_attempts', 'nomad_contentflow.delivery_attempts'),
  (17, 'public.site_checks', 'nomad_contentflow.site_checks'),
  (18, 'public.cost_entries', 'nomad_contentflow.cost_entries'),
  (19, 'public.improvement_tasks', 'nomad_contentflow.improvement_tasks'),
  (20, 'public.blog_usage_snapshots', 'nomad_contentflow.blog_usage_snapshots'),
  (21, 'public.publish_jobs', 'nomad_contentflow.publish_jobs'),
  (22, 'public.rate_limits', 'nomad_contentflow_private.rate_limits');

create temp table cf_problems (msg text not null) on commit drop;

-- 대상 컬럼 ← 원본 식. 원본에 없는 updated_at은 created_at, 나머지 새 컬럼(deleted_at 등)은 기본값.
-- 기본값 없는 필수 컬럼이 비거나, 원본 컬럼이 새 표에 없으면(데이터 손실) 중단.
create function pg_temp.cf_columns(p_legacy regclass, p_target regclass)
returns table (target_col text, source_expr text)
language plpgsql stable
as $$
declare
  c record;
  src text;
  dropped text;
begin
  for c in
    select a.attname::text as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as typ,
           ty.typtype, a.attnotnull, a.atthasdef
    from pg_catalog.pg_attribute a join pg_catalog.pg_type ty on ty.oid = a.atttypid
    where a.attrelid = p_target and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
    order by a.attnum
  loop
    src := case when c.name = 'organization_id' then 'workspace_id' else c.name end;
    if exists (select 1 from pg_catalog.pg_attribute
               where attrelid = p_legacy and attname = src and attnum > 0 and not attisdropped) then
      target_col := c.name;
      source_expr := case when c.typtype = 'e' then format('%I::text::%s', src, c.typ) else quote_ident(src) end;
      return next;
    elsif c.name = 'updated_at' and exists (select 1 from pg_catalog.pg_attribute
               where attrelid = p_legacy and attname = 'created_at' and not attisdropped) then
      target_col := c.name;
      source_expr := 'created_at';
      return next;
    elsif c.attnotnull and not c.atthasdef then
      raise exception 'NOMAD_CUTOVER_UNMAPPED: %.% 에 옮길 원본 컬럼이 없다', p_target, c.name;
    end if;
  end loop;

  select string_agg(a.attname, ', ') into dropped
  from pg_catalog.pg_attribute a
  where a.attrelid = p_legacy and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
    and not exists (
      select 1 from pg_catalog.pg_attribute b
      where b.attrelid = p_target and b.attnum > 0 and not b.attisdropped
        and b.attname = case when a.attname = 'workspace_id' then 'organization_id' else a.attname end);
  if dropped is not null then
    raise exception 'NOMAD_CUTOVER_DROPPED_COLUMN: % 의 [%] 가 %에 없다', p_legacy, dropped, p_target;
  end if;
end;
$$;

-- ── 시작 검사 ──────────────────────────────────────────────
do $$
declare
  t record;
  n bigint;
  expr text;
begin
  if current_setting('session_replication_role') <> 'replica' then
    raise exception 'NOMAD_CUTOVER_REPLICA_OFF: set local session_replication_role = replica 가 적용되지 않았다';
  end if;

  if to_regclass('nomad_cutover.frozen_at') is null then
    insert into cf_problems values ('NOMAD_CUTOVER_NOT_FROZEN: 01_freeze.sql 을 먼저 적용한다');
  end if;

  -- 재실행 방지: 대상이 하나라도 차 있으면 중단
  for t in select target from cf_tables
           union all select 'nomad_contentflow.reviewers'::regclass loop
    execute format('select count(*) from %s', t.target) into n;
    if n > 0 then
      insert into cf_problems values (format('NOMAD_CUTOVER_TARGET_NOT_EMPTY: %s %s행', t.target, n));
    end if;
  end loop;
  select count(*) into n from nomad_core.organizations o where o.id in (select id from public.workspaces);
  if n > 0 then insert into cf_problems values (format('NOMAD_CUTOVER_TARGET_NOT_EMPTY: workspace id와 같은 조직 %s개', n)); end if;
  select count(*) into n from nomad_core.subscriptions s where s.product_code = 'contentflow';
  if n > 0 then insert into cf_problems values (format('NOMAD_CUTOVER_TARGET_NOT_EMPTY: contentflow 구독 %s행', n)); end if;

  -- 익명 사용자 소유 행: 옛 표에서 auth.users를 가리키는 모든 FK 컬럼
  for t in
    select c.conrelid::regclass as tbl, a.attname
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'auth.users'::regclass
      and c.connamespace = 'public'::regnamespace
  loop
    execute format('select count(*) from %s x join auth.users u on u.id = x.%I where u.is_anonymous', t.tbl, t.attname) into n;
    if n > 0 then
      insert into cf_problems values (format('NOMAD_CUTOVER_ANONYMOUS: %s.%s 익명 사용자 행 %s건', t.tbl, t.attname, n));
    end if;
  end loop;

  -- 플랜
  for t in select w.plan, count(*) as n from public.workspaces w
           where not exists (select 1 from cf_plan_map m where m.legacy_plan = w.plan) group by w.plan loop
    insert into cf_problems values (format('NOMAD_CUTOVER_PLAN_UNMAPPED: plan=%L workspace %s개', t.plan, t.n));
  end loop;
  for t in select distinct m.plan_code from public.workspaces w join cf_plan_map m on m.legacy_plan = w.plan
           where not exists (select 1 from nomad_core.plans p where p.product_code = 'contentflow' and p.code = m.plan_code) loop
    insert into cf_problems values (format('NOMAD_CUTOVER_PLAN_MISSING: nomad_core.plans(contentflow, %s) 시드가 없다', t.plan_code));
  end loop;
  select count(*) into n
  from public.workspace_entitlements e
  join public.workspaces w on w.id = e.workspace_id
  join cf_plan_map m on m.legacy_plan = w.plan
  where e.plan is distinct from w.plan
     or e.included_blogs is distinct from (select l.limit_value from nomad_core.plan_limits l
          where l.product_code = 'contentflow' and l.plan_code = m.plan_code and l.limit_key = 'included_blogs')
     or e.max_blogs is distinct from (select l.limit_value from nomad_core.plan_limits l
          where l.product_code = 'contentflow' and l.plan_code = m.plan_code and l.limit_key = 'max_blogs')
     or e.overage_allowed::int is distinct from (select l.limit_value from nomad_core.plan_limits l
          where l.product_code = 'contentflow' and l.plan_code = m.plan_code and l.limit_key = 'overage_allowed');
  if n > 0 then
    insert into cf_problems values (format('NOMAD_CUTOVER_ENTITLEMENT_MISMATCH: 옛 이용권이 새 plan_limits와 다른 workspace %s개(한도 시드 없음 포함)', n));
  end if;
  select count(*) into n from public.workspace_entitlements e where e.grace_until > now();
  if n > 0 then
    insert into cf_problems values (format('NOMAD_CUTOVER_GRACE_ACTIVE: 유예 중인 workspace %s개(새 구조에 유예 없음)', n));
  end if;

  -- 사람·조직
  select count(*) into n
  from (select user_id from public.memberships union select owner_id from public.workspaces) u
  where not exists (
    select 1 from nomad_core.memberships m join nomad_core.organizations o on o.id = m.organization_id
    where m.user_id = u.user_id and o.kind = 'personal' and m.role = 'owner');
  if n > 0 then
    insert into cf_problems values (format('NOMAD_CUTOVER_NO_PERSONAL_ORG: 개인 조직 없는 사용자 %s명(db push 백필 확인)', n));
  end if;
  select count(*) into n from public.workspaces w
  where not exists (select 1 from public.memberships m
                    where m.workspace_id = w.id and m.user_id = w.owner_id and m.role = 'owner');
  if n > 0 then
    insert into cf_problems values (format('NOMAD_CUTOVER_OWNER_MISSING: owner_id의 owner 멤버십이 없는 workspace %s개', n));
  end if;

  -- 새 표 check 제약(옛 NOT VALID 제약으로 남은 행 등)에 걸리는 옛 행
  for t in
    select ct.legacy, ct.target, c.conname, pg_catalog.pg_get_expr(c.conbin, c.conrelid) as expr
    from cf_tables ct join pg_catalog.pg_constraint c on c.conrelid = ct.target and c.contype = 'c'
  loop
    begin
      execute format('select count(*) from %s where (%s) is false', t.legacy, t.expr) into n;
    exception when others then
      raise exception 'NOMAD_CUTOVER_CHECK_EVAL: %.% 를 옛 표에서 평가하지 못했다: %', t.target, t.conname, sqlerrm;
    end;
    if n > 0 then
      insert into cf_problems values (format('NOMAD_CUTOVER_CHECK_VIOLATION: %s 의 %s 에 걸리는 옛 행 %s건', t.target, t.conname, n));
    end if;
  end loop;

  select string_agg(msg, E'\n' order by msg) into expr from cf_problems;
  if expr is not null then
    raise exception E'NOMAD_CUTOVER_ABORT: 시작 검사 실패\n%', expr;
  end if;
end $$;

-- ── 복사: 조직·멤버·검수자·구독·대기 초대 ───────────────────
insert into nomad_core.organizations (id, name, active, created_at, kind, created_by, seat_limit)
select w.id, w.name, true, w.created_at, 'team', w.owner_id, null
from public.workspaces w;

insert into nomad_core.memberships (organization_id, user_id, role)
select m.workspace_id, m.user_id, r.role
from public.memberships m join cf_role_map r on r.legacy_role = m.role::text;

insert into nomad_contentflow.reviewers (organization_id, user_id, created_at)
select m.workspace_id, m.user_id, m.created_at
from public.memberships m join cf_role_map r on r.legacy_role = m.role::text
where r.reviewer;

insert into nomad_core.subscriptions (organization_id, product_code, plan_code, status, starts_at, ends_at)
select w.id, 'contentflow', p.plan_code, 'active', coalesce(e.updated_at, w.created_at), null
from public.workspaces w
join cf_plan_map p on p.legacy_plan = w.plan
left join public.workspace_entitlements e on e.workspace_id = w.id;

-- 수락된 초대는 결과가 멤버십에 있으므로 옮기지 않는다. 대기 초대는 새 token, 만료는 전환 시점 + 7일.
insert into nomad_core.invitations (id, organization_id, email, role, invited_by, expires_at, created_at)
select i.id, i.workspace_id, lower(btrim(i.email)), r.role, i.invited_by, now() + interval '7 days', i.created_at
from public.invitations i join cf_role_map r on r.legacy_role = i.role::text
where i.accepted_at is null;

-- ── 복사: 제품 표 ─────────────────────────────────────────
do $$
declare
  t record;
  cols text;
  srcs text;
  r record;
begin
  for t in select * from cf_tables order by ord loop
    select string_agg(quote_ident(target_col), ', '), string_agg(source_expr, ', ')
      into cols, srcs from pg_temp.cf_columns(t.legacy, t.target);
    execute format('insert into %s (%s) overriding system value select %s from %s', t.target, cols, srcs, t.legacy);
  end loop;

  -- identity·serial 시퀀스를 옮긴 최댓값 뒤로
  for r in
    select a.attrelid::regclass as tbl, a.attname
    from pg_catalog.pg_attribute a
    where a.attrelid in (select target from cf_tables) and a.attnum > 0 and not a.attisdropped
      and pg_catalog.pg_get_serial_sequence(a.attrelid::regclass::text, a.attname) is not null
  loop
    execute format('select setval(pg_get_serial_sequence(%L, %L), coalesce((select max(%I) from %s), 1), (select count(*) > 0 from %s))',
      r.tbl::text, r.attname, r.attname, r.tbl, r.tbl);
  end loop;
end $$;

-- ── 끝 검사 ───────────────────────────────────────────────
do $$
declare
  t record;
  cols text;
  srcs text;
  n_legacy bigint;
  n_target bigint;
  n_missing bigint;
  n_extra bigint;
  fk record;
  cond text;
  nn_cond text;
  bad text := '';
begin
  if current_setting('session_replication_role') <> 'replica' then
    raise exception 'NOMAD_CUTOVER_REPLICA_OFF: 복사 중 replica 모드가 풀렸다';
  end if;

  -- 제품 표: 행 수 + 옮긴 컬럼 전체 값(id·organization_id 소유 포함) 양방향 대조
  for t in select * from cf_tables order by ord loop
    select string_agg(quote_ident(target_col), ', '), string_agg(source_expr, ', ')
      into cols, srcs from pg_temp.cf_columns(t.legacy, t.target);
    execute format('select count(*) from %s', t.legacy) into n_legacy;
    execute format('select count(*) from %s', t.target) into n_target;
    execute format('select count(*) from (select %s from %s except all select %s from %s) d', srcs, t.legacy, cols, t.target) into n_missing;
    execute format('select count(*) from (select %s from %s except all select %s from %s) d', cols, t.target, srcs, t.legacy) into n_extra;
    if n_legacy <> n_target or n_missing > 0 or n_extra > 0 then
      bad := bad || format(E'\n%s: 원본 %s행 · 대상 %s행 · 누락 %s · 초과 %s', t.target, n_legacy, n_target, n_missing, n_extra);
    end if;
  end loop;

  -- 조직·멤버·검수자·구독·초대
  select count(*) into n_missing from (
    (select id, name, owner_id, created_at from public.workspaces
     except select id, name, created_by, created_at from nomad_core.organizations where kind = 'team' and active)
    union all
    (select id, name, created_by, created_at from nomad_core.organizations where id in (select id from public.workspaces)
     except select id, name, owner_id, created_at from public.workspaces)) d;
  if n_missing > 0 then bad := bad || format(E'\norganizations: 어긋난 행 %s', n_missing); end if;

  select count(*) into n_missing from (
    (select m.workspace_id, m.user_id, r.role from public.memberships m join cf_role_map r on r.legacy_role = m.role::text
     except all select organization_id, user_id, role from nomad_core.memberships where organization_id in (select id from public.workspaces))
    union all
    (select organization_id, user_id, role from nomad_core.memberships where organization_id in (select id from public.workspaces)
     except all select m.workspace_id, m.user_id, r.role from public.memberships m join cf_role_map r on r.legacy_role = m.role::text)) d;
  if n_missing > 0 then bad := bad || format(E'\nmemberships: 어긋난 행 %s', n_missing); end if;

  select count(*) into n_missing from (
    (select workspace_id, user_id from public.memberships where role = 'reviewer'
     except all select organization_id, user_id from nomad_contentflow.reviewers)
    union all
    (select organization_id, user_id from nomad_contentflow.reviewers
     except all select workspace_id, user_id from public.memberships where role = 'reviewer')) d;
  if n_missing > 0 then bad := bad || format(E'\nreviewers: 어긋난 행 %s', n_missing); end if;

  select count(*) into n_missing from (
    (select w.id, p.plan_code from public.workspaces w join cf_plan_map p on p.legacy_plan = w.plan
     except all select organization_id, plan_code from nomad_core.subscriptions where product_code = 'contentflow' and status = 'active')
    union all
    (select organization_id, plan_code from nomad_core.subscriptions where product_code = 'contentflow'
     except all select w.id, p.plan_code from public.workspaces w join cf_plan_map p on p.legacy_plan = w.plan)) d;
  if n_missing > 0 then bad := bad || format(E'\nsubscriptions: 어긋난 행 %s', n_missing); end if;

  select count(*) into n_missing from (
    (select i.id, i.workspace_id, lower(btrim(i.email)), r.role, i.invited_by from public.invitations i
       join cf_role_map r on r.legacy_role = i.role::text where i.accepted_at is null
     except all select id, organization_id, email, role, invited_by from nomad_core.invitations
       where organization_id in (select id from public.workspaces))
    union all
    (select id, organization_id, email, role, invited_by from nomad_core.invitations
       where organization_id in (select id from public.workspaces)
     except all select i.id, i.workspace_id, lower(btrim(i.email)), r.role, i.invited_by from public.invitations i
       join cf_role_map r on r.legacy_role = i.role::text where i.accepted_at is null)) d;
  if n_missing > 0 then bad := bad || format(E'\ninvitations: 어긋난 행 %s', n_missing); end if;

  -- FK 고아 행: replica 모드는 FK 트리거도 끄므로 nomad_core·제품 스키마의 모든 FK(복합 (organization_id, id) 포함)를 직접 확인
  for fk in
    select c.conname, c.conrelid::regclass as child, c.confrelid::regclass as parent, c.conkey, c.confkey
    from pg_catalog.pg_constraint c
    where c.contype = 'f'
      and c.connamespace in ('nomad_core'::regnamespace, 'nomad_contentflow'::regnamespace, 'nomad_contentflow_private'::regnamespace)
  loop
    select string_agg(format('y.%I = x.%I', pa.attname, ca.attname), ' and '),
           string_agg(format('x.%I is not null', ca.attname), ' and ')
      into cond, nn_cond
    from unnest(fk.conkey, fk.confkey) with ordinality k(ck, pk, i)
    join pg_catalog.pg_attribute ca on ca.attrelid = fk.child and ca.attnum = k.ck
    join pg_catalog.pg_attribute pa on pa.attrelid = fk.parent and pa.attnum = k.pk;
    execute format('select count(*) from %s x where %s and not exists (select 1 from %s y where %s)',
      fk.child, nn_cond, fk.parent, cond) into n_missing;
    if n_missing > 0 then
      bad := bad || format(E'\nFK %s (%s → %s): 고아 행 %s', fk.conname, fk.child, fk.parent, n_missing);
    end if;
  end loop;

  if bad <> '' then
    raise exception E'NOMAD_CUTOVER_VERIFY_FAILED:%', bad;
  end if;

  raise notice 'NOMAD_CUTOVER_VERIFIED: 조직 %, 멤버 %, 검수자 %, 구독 %, 대기 초대 %, 제품 표 % 개 일치',
    (select count(*) from public.workspaces), (select count(*) from public.memberships),
    (select count(*) from nomad_contentflow.reviewers),
    (select count(*) from nomad_core.subscriptions where product_code = 'contentflow'),
    (select count(*) from public.invitations where accepted_at is null),
    (select count(*) from cf_tables);
end $$;

\if :apply
commit;
\echo NOMAD_CUTOVER_APPLIED
\else
rollback;
\echo NOMAD_CUTOVER_DRY_RUN_OK (rolled back)
\endif
