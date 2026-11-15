# 현재 상태 (2026-11-15)

| 항목 | 상태 |
|---|---|
| 최근 완료 | CF-07b 기획 r2(`docs/01-planning/ANALYTICS_SYNC.md`, 세션 기반·GSC→AdSense→GA4·토큰 AES-GCM, 다이어그램 2종). 그 전: CF-24 e2e 17/17 통과(로컬 Supabase 60321·WordPress 8081, 결과 `.nomad/logs/publish-queue/results.md`). e2e 스크립트 `E2E_WP_URL` 지원 커밋. 그 전: CF-07c 분리·문서 정정 |
| 검증 | 단위(웹) 355, typecheck·build, `supabase/tests/run.ps1` ALL PASSED, W8 e2e 67(11-12), 발행 큐 e2e 17(11-15) |
| 진행 중 | CF-07b — A1~A5(GSC 연결·수집·화면) 완료·커밋. 다음 A6 AdSense 수집기(위험 높음), A7 GA4(선택), A8 문서. 실 Google 검증은 OAuth 클라이언트 발급 후 |
| 대기(입력 필요) | CF-23 실결제(결제사 결정, 위험 높음) · CF-07b 구현(미결 D3~D9: 동기화 주기·과거 일수, 해제 시 데이터, 겹침 안내, PAGE_URL, 동의 화면·검증, Google 클라이언트 발급 주체, 토큰 상한) · CF-06 부 모델 ID |
| 미검증 | CF-12 실제 OpenAI 키 호출 |
| CF-22 남은 것 | 다중 Free 워크스페이스 남용 기준 미결정(§11) |
| 운영 준비 | 클라우드 Supabase, https·`COOKIE_SECURE`, 실제 메일 발송, 로그인 시도 제한 공유 저장소 |
| 규칙 | 새 RPC에서 `set_config('role')`·SET ROLE 금지(0019 `cf_caller_is_client` fail-closed). 클라이언트는 `blog.*` audit 행 쓰기 불가 |
| 운영 | 로컬 Supabase 60321~, 웹 3410, WordPress 8081(`docker compose -f docker-compose.wp-dev.yml up -d`) |
| 키 | 루트 `.env`, `.env.local` — git 제외. WP e2e 자격은 컨테이너에서 애플리케이션 비밀번호 생성(저장소 밖 파일) |
| 모델 | Codex 사용 한도 → reviewer 대체 |
