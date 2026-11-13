# 현재 상태 (2026-11-13)

| 항목 | 상태 |
|---|---|
| 최근 완료 | CF-22 다수 블로그 한도·초과 고지(0019 엔타이틀먼트·한도 트리거·KST 월 peak·90일 유예, 사용량 API·배지·고지 대화상자) |
| 검증 | 단위(웹) 342, typecheck·build, `supabase/tests/run.ps1` ALL PASSED, reviewer security·contract 지적 반영 |
| 다음 | **CF-24 발행 큐** — 명세 `docs/06-workflows/PUBLISH_QUEUE.md`(§15 확정: 웹 내 drain·사용자 세션 선점 RPC·`/api/wordpress/draft` 교체), 그림 `docs/diagrams/publish-queue-*.mmd`. 위험 높음 → challenger 먼저 |
| CF-22 남은 것 | 브라우저 수동 확인(3구간·포커스) 미실시 — e2e 추가 후보. 다중 Free 워크스페이스 남용 기준은 미결정(§11) |
| 이관 | 다운그레이드 보관 요구·`BLOG_OVER_ENTITLEMENT` → CF-23(실결제, 승인 필요) |
| 규칙 | 새 RPC에서 `set_config('role')`·SET ROLE 금지(0019 `cf_caller_is_client` fail-closed). 클라이언트는 `blog.*` audit 행 쓰기 불가 |
| 운영 | 로컬 Supabase 60321~, 웹 3410, WordPress 8081 |
| 키 | 루트 `.env`, `.env.local` — git 제외 |
| 모델 | Codex 사용 한도 → reviewer 대체 |
