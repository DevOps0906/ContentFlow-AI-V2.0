-- ContentFlow nomad DB 전환 1단계: 옛 public 표 쓰기 중지(표·함수·데이터는 그대로 둔다).
-- 사용: psql "<DB 주소(postgres)>" -v ON_ERROR_STOP=1 -f supabase/nomad-cutover/01_freeze.sql
-- 되돌림: 01_freeze_undo.sql (쓰기 재개 전까지만. 절차: docs/ops/NOMAD_DB_CUTOVER.md)
-- 하는 일
--   1) 옛 표 26개의 insert·update·delete·truncate 권한을 anon·authenticated·service_role(+public)에서 회수하고 기록
--   2) 같은 표에 쓰기 거부 트리거(nomad_cutover_freeze)를 건다 — security definer RPC·소유자 쓰기도 막는다
--   3) auth.users의 옛 트리거(nomad_* 제외)를 끄고 기록 (ContentFlow 옛 0001~0027에는 없음 → 보통 0건)
--   4) 이 DB의 pg_cron 작업을 기록하고 unschedule (ContentFlow 옛 0001~0027에는 없음 → 보통 0건)
-- 기록은 비노출 스키마 nomad_cutover에 남고, 02_copy.sql은 이 기록이 없으면 실행을 거부한다.
begin;

do $$
begin
  if to_regnamespace('nomad_cutover') is not null then
    raise exception 'NOMAD_CUTOVER_ALREADY_FROZEN: 01_freeze가 이미 적용됐다(되돌림은 01_freeze_undo.sql)';
  end if;
end $$;

create schema nomad_cutover;
revoke all on schema nomad_cutover from public, anon, authenticated, service_role;
comment on schema nomad_cutover is 'ContentFlow nomad DB 전환 기록(01_freeze). API 비노출. 01_freeze_undo.sql이 지운다.';

create table nomad_cutover.legacy_tables (name text primary key);
create table nomad_cutover.revoked_grants (
  table_name text not null,
  grantee text not null,
  privilege text not null,
  grantable boolean not null,
  primary key (table_name, grantee, privilege)
);
create table nomad_cutover.disabled_triggers (name text primary key);
create table nomad_cutover.unscheduled_jobs (
  jobname text primary key,
  schedule text not null,
  command text not null,
  active boolean not null
);
create table nomad_cutover.frozen_at (at timestamptz primary key default now());
insert into nomad_cutover.frozen_at default values;

alter table nomad_cutover.legacy_tables enable row level security;
alter table nomad_cutover.revoked_grants enable row level security;
alter table nomad_cutover.disabled_triggers enable row level security;
alter table nomad_cutover.unscheduled_jobs enable row level security;
alter table nomad_cutover.frozen_at enable row level security;
revoke all on all tables in schema nomad_cutover from public, anon, authenticated, service_role;

-- 옛 0001~0027이 만든 표 전부(products/contentflow/existing.md 표 순서)
insert into nomad_cutover.legacy_tables (name) values
  ('workspaces'), ('memberships'), ('invitations'), ('blogs'), ('sources'), ('articles'),
  ('article_versions'), ('approvals'), ('audit_logs'), ('keywords'), ('revenue_rows'), ('rate_limits'),
  ('agent_runs'), ('article_state_events'), ('delivery_attempts'), ('site_checks'), ('cost_entries'),
  ('improvement_tasks'), ('keyword_trends'), ('blog_metric_snapshots'), ('workspace_entitlements'),
  ('blog_usage_snapshots'), ('publish_jobs'), ('analytics_connections'), ('analytics_credentials'),
  ('analytics_sync_runs');

create function nomad_cutover.reject_legacy_write()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception 'NOMAD_CUTOVER_FROZEN: public.% 는 nomad DB 전환 중이라 쓰기가 중지됐다', tg_table_name
    using errcode = '55000';
end;
$$;
revoke all on function nomad_cutover.reject_legacy_write() from public, anon, authenticated, service_role;

do $$
declare
  t record;
  missing text;
  col_grants text;
  trg record;
  job record;
begin
  select string_agg(l.name, ', ') into missing
  from nomad_cutover.legacy_tables l
  where to_regclass(format('public.%I', l.name)) is null;
  if missing is not null then
    raise exception 'NOMAD_CUTOVER_LEGACY_MISSING: 옛 표가 없다: %', missing;
  end if;

  -- 컬럼 단위 쓰기 권한은 표 단위 revoke로 안 지워지므로, 있으면 사람이 먼저 본다.
  select string_agg(distinct c.relname || '.' || a.attname, ', ') into col_grants
  from nomad_cutover.legacy_tables l
  join pg_catalog.pg_class c on c.relname = l.name and c.relnamespace = 'public'::regnamespace
  join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attacl is not null
  cross join lateral pg_catalog.aclexplode(a.attacl) x
  where x.privilege_type in ('INSERT', 'UPDATE');
  if col_grants is not null then
    raise exception 'NOMAD_CUTOVER_COLUMN_GRANTS: 컬럼 단위 쓰기 권한이 있다: %', col_grants;
  end if;

  insert into nomad_cutover.revoked_grants (table_name, grantee, privilege, grantable)
  select c.relname,
         case when x.grantee = 0 then 'public' else pg_catalog.pg_get_userbyid(x.grantee) end,
         x.privilege_type, x.is_grantable
  from nomad_cutover.legacy_tables l
  join pg_catalog.pg_class c on c.relname = l.name and c.relnamespace = 'public'::regnamespace
  cross join lateral pg_catalog.aclexplode(c.relacl) x
  where x.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    and (x.grantee = 0 or pg_catalog.pg_get_userbyid(x.grantee) in ('anon', 'authenticated', 'service_role'));

  for t in select * from nomad_cutover.revoked_grants loop
    execute format('revoke %s on table public.%I from %s', t.privilege, t.table_name,
      case when t.grantee = 'public' then 'public' else quote_ident(t.grantee) end);
  end loop;

  for t in select name from nomad_cutover.legacy_tables loop
    execute format(
      'create trigger nomad_cutover_freeze before insert or update or delete or truncate on public.%I '
      'for each statement execute function nomad_cutover.reject_legacy_write()', t.name);
  end loop;

  for trg in
    select tg.tgname from pg_catalog.pg_trigger tg
    where tg.tgrelid = 'auth.users'::regclass and not tg.tgisinternal
      and tg.tgenabled <> 'D' and tg.tgname not like 'nomad\_%'
  loop
    insert into nomad_cutover.disabled_triggers (name) values (trg.tgname);
    execute format('alter table auth.users disable trigger %I', trg.tgname);
  end loop;

  if to_regclass('cron.job') is not null then
    for job in
      execute 'select jobname, schedule, command, active from cron.job where database = current_database()'
    loop
      if job.jobname is null then
        raise exception 'NOMAD_CUTOVER_CRON_UNNAMED: 이름 없는 pg_cron 작업은 되돌릴 수 없다 — 이름을 붙인 뒤 다시 실행';
      end if;
      insert into nomad_cutover.unscheduled_jobs values (job.jobname, job.schedule, job.command, job.active);
      execute 'select cron.unschedule($1)' using job.jobname;
    end loop;
  end if;

  raise notice 'NOMAD_CUTOVER_FROZEN: 권한 회수 %건, 트리거 % 표, auth 트리거 %건, cron %건',
    (select count(*) from nomad_cutover.revoked_grants),
    (select count(*) from nomad_cutover.legacy_tables),
    (select count(*) from nomad_cutover.disabled_triggers),
    (select count(*) from nomad_cutover.unscheduled_jobs);
end $$;

commit;
