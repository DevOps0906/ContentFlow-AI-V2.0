-- 01_freeze.sql 되돌림: 기록한 권한·auth 트리거·pg_cron 작업을 그대로 복구하고 쓰기 거부 트리거와 nomad_cutover 스키마를 지운다.
-- 사용: psql "<DB 주소(postgres)>" -v ON_ERROR_STOP=1 -f supabase/nomad-cutover/01_freeze_undo.sql
-- 쓰기 재개(새 앱 배포) 뒤에는 실행하지 않는다 — 옛 표는 계속 멈춰 있어야 한다(docs/ops/NOMAD_DB_CUTOVER.md).
begin;

do $$
declare
  t record;
begin
  if to_regnamespace('nomad_cutover') is null then
    raise exception 'NOMAD_CUTOVER_NOT_FROZEN: 01_freeze 기록(nomad_cutover)이 없다';
  end if;

  for t in select name from nomad_cutover.legacy_tables loop
    execute format('drop trigger if exists nomad_cutover_freeze on public.%I', t.name);
  end loop;

  for t in select * from nomad_cutover.revoked_grants loop
    execute format('grant %s on table public.%I to %s%s', t.privilege, t.table_name,
      case when t.grantee = 'public' then 'public' else quote_ident(t.grantee) end,
      case when t.grantable then ' with grant option' else '' end);
  end loop;

  for t in select name from nomad_cutover.disabled_triggers loop
    execute format('alter table auth.users enable trigger %I', t.name);
  end loop;

  for t in select * from nomad_cutover.unscheduled_jobs loop
    execute 'select cron.schedule($1, $2, $3)' using t.jobname, t.schedule, t.command;
    if not t.active then
      execute 'select cron.alter_job((select jobid from cron.job where jobname = $1 and database = current_database()), active := false)'
        using t.jobname;
    end if;
  end loop;
end $$;

drop schema nomad_cutover cascade;

commit;
