#!/usr/bin/env bash
# ContentFlow nomad DB 전환 스크립트(01·02) 검사. 운영 DB에는 접속하지 않는다.
# 사용: bash supabase/nomad-cutover/check.sh
# 로컬 Supabase DB 컨테이너(기본 supabase_db_nomad-supabase-module, NOMAD_CUTOVER_CONTAINER로 변경) 안에
# 일회용 DB cutover_contentflow 를 매번 새로 만들어 쓴다. 다른 DB는 건드리지 않는다.
# 순서: 플랫폼 최소 형태(auth·vault) → legacy-migrations → 합성 seed → migrations(db push 대역) → 플랜 시드
#      → 01 → 02 dry-run(변경 없음) → 02 apply → 값·RLS 확인 → 02 재실행 거부 → 익명·옛 check 위반 행 중단 → 01_undo 복구
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"; S="$(dirname "$D")"
C="${NOMAD_CUTOVER_CONTAINER:-supabase_db_nomad-supabase-module}"
DB=cutover_contentflow

admin() { docker exec -i "$C" psql -X -q -U supabase_admin -v ON_ERROR_STOP=1 "$@"; }
pg() { docker exec -i -e PGOPTIONS=-cclient_min_messages=warning "$C" psql -X -q -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
val() { pg -tA -c "$1" < /dev/null; }
step() { echo "== $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
# 대상 표 전체 행 수(dry-run 전후 비교용)
TARGET_COUNT="select (select count(*) from nomad_core.organizations) + (select count(*) from nomad_core.memberships)
  + (select count(*) from nomad_core.subscriptions) + (select count(*) from nomad_core.invitations)
  + (select coalesce(sum((xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', schemaname, tablename), false, true, '')))[1]::text::bigint), 0)
     from pg_tables where schemaname in ('nomad_contentflow', 'nomad_contentflow_private'))"
ACL="select string_agg(x, ' ' order by x) from (
  select c.relname || ':' || coalesce(pg_get_userbyid(a.grantee), 'public') || ':' || a.privilege_type as x
  from pg_class c cross join lateral aclexplode(c.relacl) a
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r') s"

step "일회용 DB $DB 재생성"
docker inspect "$C" > /dev/null 2>&1 || fail "컨테이너 $C 없음(npx supabase start)"
admin -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB owner postgres" < /dev/null
admin -d "$DB" < "$D/test/00_stub_platform.sql"

step "옛 legacy-migrations 적용 + 합성 seed"
cat "$S"/legacy-migrations/*.sql | pg > /dev/null
pg < "$D/test/10_seed_legacy.sql" > /dev/null

step "새 migrations 적용(db push 대역, 개인 조직 백필) + 플랜 시드"
cat "$S"/migrations/*.sql | pg > /dev/null
pg < "$D/test/20_plans_seed.sql" > /dev/null
[ "$(val "select count(*) from nomad_core.organizations where kind = 'personal'")" = 2 ] || fail "백필 개인 조직 2개가 아님"

step "01_freeze"
ACL_BEFORE="$(val "$ACL")"
pg < "$D/01_freeze.sql" > /dev/null
[ "$(val "select count(*) from nomad_cutover.revoked_grants where grantee = 'authenticated'")" -gt 0 ] || fail "회수 기록 없음"
WRITE_PRIV="select count(*) from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['INSERT', 'UPDATE', 'DELETE']) p
  where has_table_privilege(r, 'public.blogs', p)"
[ "$(val "$WRITE_PRIV")" = 0 ] || fail "01 뒤에도 API 역할에 public.blogs 쓰기 권한이 남음"
out="$(pg -c "update public.workspaces set name = name" < /dev/null 2>&1)" && fail "소유자 쓰기가 막히지 않음"
echo "$out" | grep -q NOMAD_CUTOVER_FROZEN || fail "소유자 쓰기 거부 사유가 다름: $out"
out="$(pg < "$D/01_freeze.sql" 2>&1)" && fail "01 재실행이 거부되지 않음"
echo "$out" | grep -q NOMAD_CUTOVER_ALREADY_FROZEN || fail "01 재실행 사유: $out"

step "02 dry-run(변경 없음)"
before="$(val "$TARGET_COUNT")"
out="$(pg < "$D/02_copy.sql" 2>&1)" || fail "02 dry-run 실패: $out"
echo "$out" | grep -q "NOMAD_CUTOVER_DRY_RUN_OK" || fail "dry-run 표식 없음: $out"
[ "$(val "$TARGET_COUNT")" = "$before" ] || fail "dry-run 뒤 대상 행 수가 바뀜"

step "02 apply"
out="$(pg -v apply=1 < "$D/02_copy.sql" 2>&1)" || fail "02 apply 실패: $out"
echo "$out" | grep -q NOMAD_CUTOVER_APPLIED || fail "apply 표식 없음: $out"
[ "$(val "select count(*) from nomad_contentflow.articles")" = 3 ] || fail "apply가 commit되지 않음"

step "값·RLS 격리 확인"
out="$(pg < "$D/test/30_verify_applied.sql" 2>&1)" || fail "$out"
echo "$out" | grep -q VERIFY_APPLIED_OK || fail "$out"

step "02 재실행 거부"
out="$(pg -v apply=1 < "$D/02_copy.sql" 2>&1)" && fail "02 재실행이 거부되지 않음"
echo "$out" | grep -q NOMAD_CUTOVER_TARGET_NOT_EMPTY || fail "재실행 사유: $out"

step "익명 사용자 행·옛 NOT VALID 위반 행이 있으면 중단"
pg > /dev/null <<'SQL'
begin;
set local session_replication_role = replica;
insert into auth.users (id, email, is_anonymous) values ('00000000-0000-4000-8000-0000000000c3', null, true);
insert into public.memberships (workspace_id, user_id, role) values ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c3', 'viewer');
-- 0012 이전에 들어온 수익 행(timezone·기간 없음, 옛 제약은 NOT VALID)은 새 표의 검증된 check에 걸린다.
-- 그런 행을 재현하려고 옛 제약을 잠시 빼고 넣은 뒤 같은 정의(NOT VALID)로 되돌린다.
do $$
declare d text := (select pg_get_constraintdef(oid) from pg_constraint
                   where conrelid = 'public.revenue_rows'::regclass and conname = 'revenue_rows_report_context');
begin
  alter table public.revenue_rows drop constraint revenue_rows_report_context;
  insert into public.revenue_rows (workspace_id, row_key, source, status, currency, report_date, revenue, created_by)
    values ('10000000-0000-4000-8000-000000000002', 'pre-0012', 'manual', 'estimated', 'KRW', '2025-12-01', 10, '00000000-0000-4000-8000-0000000000b2');
  execute format('alter table public.revenue_rows add constraint revenue_rows_report_context %s', d);
end $$;
commit;
SQL
out="$(pg < "$D/02_copy.sql" 2>&1)" && fail "익명 행이 있는데 02가 통과"
echo "$out" | grep -q "NOMAD_CUTOVER_ANONYMOUS: memberships.user_id 익명 사용자 행 1건" || fail "익명 중단 사유: $out"
echo "$out" | grep -q "NOMAD_CUTOVER_CHECK_VIOLATION: nomad_contentflow.revenue_rows 의 revenue_rows_report_context" || fail "check 위반 사유: $out"
pg > /dev/null <<'SQL'
begin;
set local session_replication_role = replica;
delete from public.revenue_rows where row_key = 'pre-0012';
delete from public.memberships where user_id = '00000000-0000-4000-8000-0000000000c3';
delete from auth.users where id = '00000000-0000-4000-8000-0000000000c3';
commit;
SQL

step "01_freeze_undo 복구"
pg < "$D/01_freeze_undo.sql" > /dev/null
[ "$(val "$ACL")" = "$ACL_BEFORE" ] || fail "undo 뒤 권한이 01 전과 다름"
[ "$(val "select count(*) from pg_trigger where tgname = 'nomad_cutover_freeze'")" = 0 ] || fail "쓰기 거부 트리거가 남음"
[ -z "$(val "select to_regnamespace('nomad_cutover')")" ] || fail "nomad_cutover 스키마가 남음"
[ "$(val "$WRITE_PRIV")" -gt 0 ] || fail "undo 뒤 API 역할 쓰기 권한이 돌아오지 않음"
pg -c "begin; update public.workspaces set name = name; rollback;" < /dev/null > /dev/null || fail "undo 뒤 소유자 쓰기가 여전히 막힘"

echo "contentflow nomad-cutover check: PASS ($DB)"
