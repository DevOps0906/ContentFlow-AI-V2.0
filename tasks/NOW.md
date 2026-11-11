# 현재 상태 (2026-11-12 종료 시점)

| 항목 | 상태 |
|---|---|
| 오늘 완료 | W9~11 리뷰 수정(0018), W8 브라우저 검증(67), Supabase 로컬·Cloud 분리, AI API 탭·Gemini, 문서 정합화(DB·ERD·WORKFLOWS), 템플릿 10종 예시 글, GNB 정리·환경설정, 하이드레이션 수정, 로컬 Supabase 가이드, Capacitor W0(서버 Bearer·apps/mobile·shell-bridge·대시보드 APK 카드), 개발용 APK 첫 빌드. 모두 커밋·푸시 |
| 검증 | 단위 웹 293·mobile 8·shell-bridge 8, typecheck·build·Docker 빌드, e2e W8 67·템플릿 27·모바일 22, npm audit 0 |
| 다음 후보 | (1) 휴대폰에 개발용 APK 설치·실기기 확인(보안 저장소 CF-M-003 완료 판정) (2) 승인 대기 글이 있는 상태의 모바일 확인 (3) 구글 로그인(웹 → 모바일은 시스템 브라우저+딥링크) — Google OAuth 클라이언트 필요 (4) Gemini 이미지 결제 후 예시 이미지 생성 (5) Cloud Supabase·https 배포(승인) (6) P0-04 필수 블록 차단, L02 목차·비교표 |
| 빌드 환경 | JDK 21(`JAVA_HOME`), Android SDK 명령줄 도구(`ANDROID_HOME`), 서명 키 `%USERPROFILE%\.contentflow\`(백업 필요). 절차: `docs/08-ops/MOBILE_APP_DISTRIBUTION.md` |
| 운영 | 로컬 Supabase 60321~(`pwsh scripts/supabase-local.ps1`), 웹 3410(localhost + 내부망 192.168.35.115, 방화벽 규칙 "ContentFlow dev web 3410 (LAN only)"), WordPress 8081 |
| 키 | 루트 `.env`(Supabase·내부망 바인딩), `.env.local`(GEMINI_API_KEY) — git 제외 |
| 모델 | Codex 사용 한도 → reviewer 대체 |
