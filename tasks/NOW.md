# 현재 상태 (2026-11-12)

| 항목 | 상태 |
|---|---|
| 최근 완료 | CF-19: P0-04 필수 블록 누락 시 검수·승인·전달 차단(앱+서버 API, DB 트리거 미변경), 렌더러 r2(목차·GFM 표). reviewer 지적 반영 |
| 검증 | 단위 303, typecheck·build·diff check. W8 e2e 67건 통과(본문 T01 필수 블록으로 수정 후 재실행). 푸시 완료 |
| 다음 후보 | (2) 휴대폰 APK 실기기 확인(CF-M-003) (3) 구글 로그인 — OAuth 클라이언트 필요 (4) Gemini 이미지 결제 후 예시 이미지 (5) Cloud Supabase·https 배포(승인) (6) CF-07b 광고·분석·팀 초대(광고 API 자격 필요) |
| 리뷰 후속 | 완료: 계정 API qa/approval_pending 진입도 422, 표 래퍼 `overflow:auto`(KSES 실측) → 렌더러 r3 |
| 빌드 환경 | JDK 21, Android SDK, 서명 키 `%USERPROFILE%\.contentflow\`. 절차 `docs/08-ops/MOBILE_APP_DISTRIBUTION.md` |
| 운영 | 로컬 Supabase 60321~(`pwsh scripts/supabase-local.ps1`), 웹 3410, WordPress 8081 |
| 키 | 루트 `.env`, `.env.local`(GEMINI_API_KEY) — git 제외 |
| 모델 | Codex 사용 한도 → reviewer 대체 |
