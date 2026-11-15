# 현재 상태 (2026-11-15)

| 항목 | 상태 |
|---|---|
| 최근 완료 | CF-07c 분리: 팀 초대·역할·비밀번호 재설정은 이미 구현·W8 e2e 통과 확인, 문서 상태 정정(2026-11-15). 이전: CF-24 발행 큐(0020 큐 테이블·claim/finish/cancel RPC·`/api/publish/*`·`/publish` 화면·호환 경로). 단위 355·typecheck·build·`run.ps1` ALL PASSED, reviewer security ACCEPT·contract 지적 3건 반영 |
| 검증 | 단위(웹) 342, typecheck·build, `supabase/tests/run.ps1` ALL PASSED, reviewer security·contract 지적 반영 |
| 진행 중 | 없음 — 다음 작업 선정. 남은 대기는 모두 사용자 입력 필요: CF-23(결제사 결정), CF-07b 광고·분석(API 자격), CF-24 e2e(WordPress 애플리케이션 비밀번호), CF-06(부 모델 ID) |
| CF-24 남은 것 | e2e `apps/web/tests/e2e/publish-queue.mjs <wp-cred-file>` 미실행(사용자가 WordPress 애플리케이션 비밀번호 준비 후). 테넌트 간 점유 위험은 0021(직렬화 워크스페이스 단위, 명세 §18)로 해결 — `run.ps1` ALL PASSED |
| CF-22 남은 것 | 브라우저 수동 확인(3구간·포커스) 미실시 — e2e 추가 후보. 다중 Free 워크스페이스 남용 기준은 미결정(§11) |
| 이관 | 다운그레이드 보관 요구·`BLOG_OVER_ENTITLEMENT` → CF-23(실결제, 승인 필요) |
| 규칙 | 새 RPC에서 `set_config('role')`·SET ROLE 금지(0019 `cf_caller_is_client` fail-closed). 클라이언트는 `blog.*` audit 행 쓰기 불가 |
| 운영 | 로컬 Supabase 60321~, 웹 3410, WordPress 8081 |
| 키 | 루트 `.env`, `.env.local` — git 제외 |
| 모델 | Codex 사용 한도 → reviewer 대체 |
| 미커밋 | `apps/web/tests/e2e/publish-queue.mjs` E2E_WP_URL 변경(이 세션 작업 아님, 손대지 않음) |
