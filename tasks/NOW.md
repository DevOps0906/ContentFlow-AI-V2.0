# 현재 상태 (2026-11-15)

| 항목 | 상태 |
|---|---|
| 최근 완료 | CF-24 e2e 17/17 통과(로컬 Supabase 60321·WordPress 8081, 결과 `.nomad/logs/publish-queue/results.md`). e2e 스크립트 `E2E_WP_URL` 지원 커밋. 그 전: CF-07c 분리·문서 정정 |
| 검증 | 단위(웹) 355, typecheck·build, `supabase/tests/run.ps1` ALL PASSED, W8 e2e 67(11-12), 발행 큐 e2e 17(11-15) |
| 진행 중 | 없음 — 남은 대기는 모두 사용자 입력 필요 |
| 대기(입력 필요) | CF-23 실결제(결제사 결정, 위험 높음) · CF-07b 광고·분석(API 자격) · CF-06 부 모델 ID |
| 미검증 | CF-12 실제 OpenAI 키 호출 |
| CF-22 남은 것 | 다중 Free 워크스페이스 남용 기준 미결정(§11) |
| 운영 준비 | 클라우드 Supabase, https·`COOKIE_SECURE`, 실제 메일 발송, 로그인 시도 제한 공유 저장소 |
| 규칙 | 새 RPC에서 `set_config('role')`·SET ROLE 금지(0019 `cf_caller_is_client` fail-closed). 클라이언트는 `blog.*` audit 행 쓰기 불가 |
| 운영 | 로컬 Supabase 60321~, 웹 3410, WordPress 8081(`docker compose -f docker-compose.wp-dev.yml up -d`) |
| 키 | 루트 `.env`, `.env.local` — git 제외. WP e2e 자격은 컨테이너에서 애플리케이션 비밀번호 생성(저장소 밖 파일) |
| 모델 | Codex 사용 한도 → reviewer 대체 |
