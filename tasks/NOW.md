# 현재 상태 (2026-11-16)

| 항목 | 상태 |
|---|---|
| 최근 완료 | CF-07b 광고·분석 API 동기화: 0022~0027, Google OAuth(GSC·AdSense·GA4), 수집기, 설정 연결 패널. 명세 `docs/01-planning/ANALYTICS_SYNC.md` r2 |
| 검증 | 단위 439, typecheck·build, `supabase/tests/run.ps1` ALL PASSED, e2e `analytics-oauth.mjs` 46(가짜 Google+브라우저), `publish-queue.mjs` 17, W8 67(11-12) |
| 진행 중 | CF-07b 실제 Google 검증 — 사용자 OAuth 클라이언트 발급 대기. `.env.local`에 ANALYTICS_TOKEN_KEYS·APP_URL=http://localhost:3410 추가됨(값 비공개) |
| 최근 작업(2026-11-16) | CF-25 `/naver-homefeed`(H1~H6+레퍼런스·AI 제목, 네이버 약관 반영·화면 고지), CF-26 기획·경쟁 조사·C1 고지 게이트(0028 로컬 적용)·C2·C3 쿠팡 패널. 단위 486, typecheck·build, RLS ALL PASSED |
| 사용자 필요(추가) | 네이버 검색 API 기존 키 보유 여부(신규 신청 중단), 검색광고 API 약관 원문(광고주센터 로그인), 쿠팡 파트너스 최종 승인·키·호출 제한 공식 확인 후 `COUPANG_ENABLED=1`, 클라우드 투입 전 `rate_limit_hit` RPC 확인 |
| 다음 | CF-26 C4(브랜드커넥트 링크 입력)·C6(저품질 경고) |
| 다음 후보 | CF-23은 착수 보류 — `docs/01-planning/PAYMENTS.md` §12 사용자 결정 7건 후 r2 커밋됨(세션 기반·소유자 수동 결제, D14 팀장 권고 HMAC+정산 대조) |
| 사용자 필요 | Google Cloud OAuth 클라이언트 발급(실제 연결 검증), CF-06 부 모델 ID, CF-23 결제사·가맹점 테스트 키 |
| CF-07b 후속 | GA4 다중 호스트 속성, 무인 예약 동기화(새 비밀 주체, challenger 필요), 연속 실패 시 error 전환·지수 백오프 |
| CF-22 남은 것 | 다중 Free 워크스페이스 남용 기준 미결정(§11) |
| 운영 준비 | 클라우드 Supabase, https·`COOKIE_SECURE`·`APP_URL` 필수, 실제 메일 발송, 로그인 시도 제한 공유 저장소 |
| 규칙 | 새 RPC에서 `set_config('role')`·SET ROLE 금지. service role 금지. 같은 워크스페이스 owner/admin 상호 신뢰(ANALYTICS_SYNC §7) |
| 운영 | 로컬 Supabase 60321~(11-15 `db reset`으로 개발 데이터 초기화됨), 웹 3410, WordPress 8081 |
| 키 | 루트 `.env`, `.env.local` — git 제외. Google·암호화 키 변수 이름은 `.env.example` |
| 모델 | Codex 사용 한도 → reviewer 대체 |
