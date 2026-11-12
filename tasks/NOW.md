# 현재 상태 (2026-11-12)

| 항목 | 상태 |
|---|---|
| 최근 완료 | CF-19: P0-04 필수 블록 누락 시 검수·승인·전달 차단(앱+서버 API, DB 트리거 미변경), 렌더러 r2(목차·GFM 표). reviewer 지적 반영 |
| 검증 | 단위 303, typecheck·build·diff check. W8 e2e는 본문만 T01 필수 블록으로 고침, 재실행 안 함(WordPress 컨테이너·start-server 필요) |
| 다음 후보 | (1) W8 e2e 재실행(WordPress 8081 + `node tests/e2e/start-server.mjs <wp-cred>`) (2) 휴대폰 APK 실기기 확인(CF-M-003) (3) 구글 로그인 — OAuth 클라이언트 필요 (4) Gemini 이미지 결제 후 예시 이미지 (5) Cloud Supabase·https 배포(승인) (6) CF-07b 광고·분석·팀 초대(광고 API 자격 필요) |
| 남은 리뷰 🟡 | 계정 API가 qa/approval_pending 전이는 서버에서 안 막음(승인 422로 최종 차단). WordPress KSES가 표 래퍼 inline style을 지울 수 있음 |
| 빌드 환경 | JDK 21, Android SDK, 서명 키 `%USERPROFILE%\.contentflow\`. 절차 `docs/08-ops/MOBILE_APP_DISTRIBUTION.md` |
| 운영 | 로컬 Supabase 60321~(`pwsh scripts/supabase-local.ps1`), 웹 3410, WordPress 8081 |
| 키 | 루트 `.env`, `.env.local`(GEMINI_API_KEY) — git 제외 |
| 모델 | Codex 사용 한도 → reviewer 대체 |
