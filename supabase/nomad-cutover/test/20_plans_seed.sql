-- 검사용 운영자 단계: contentflow 플랜 A/B/C와 blog 한도(plan_limits). 값은 옛 plan_defaults()와 같게(free→C, basic→B, pro→A).
-- 운영 수치는 운영자가 정한다(existing.md 팀장 확인 3). 02_copy.sql은 옛 workspace_entitlements와 이 값이 다르면 중단한다.
begin;
insert into nomad_core.plans (product_code, code, name) values
  ('contentflow', 'C', '무료'), ('contentflow', 'B', '프로'), ('contentflow', 'A', '비즈니스')
on conflict do nothing;
insert into nomad_core.plan_limits (product_code, plan_code, limit_key, limit_value) values
  ('contentflow', 'C', 'included_blogs', 1), ('contentflow', 'C', 'max_blogs', 1), ('contentflow', 'C', 'overage_allowed', 0),
  ('contentflow', 'B', 'included_blogs', 3), ('contentflow', 'B', 'max_blogs', 10), ('contentflow', 'B', 'overage_allowed', 1),
  ('contentflow', 'A', 'included_blogs', 10), ('contentflow', 'A', 'max_blogs', 30), ('contentflow', 'A', 'overage_allowed', 1)
on conflict do nothing;
commit;
