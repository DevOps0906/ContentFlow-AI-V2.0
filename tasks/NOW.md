# 현재 상태 (2026-11-12)

| 항목 | 상태 |
|---|---|
| 최근 완료 | CF-19 필수 블록·렌더러 r3, CF-D Tauri 데스크톱 W0(Windows, Next 사이드카·토큰 보호), CF-20 토스트·스낵바·⋯ 메뉴 |
| 검증 | 단위(웹) 324+, typecheck·build, W8 e2e 67, 데스크톱 실측 7건(`node apps/desktop/e2e/desktop-e2e.mjs`), cargo clippy |
| 데스크톱 | 빌드 `pwsh scripts/desktop-build.ps1` → `apps/desktop/src-tauri/target/release/bundle/nsis/`. 키 `%APPDATA%\ContentFlow\desktop.env`. 포트 34110·identifier `com.contentflow.desktop` 변경 금지. 문서 `docs/08-ops/DESKTOP_APP.md` |
| 다음 후보 | (1) 데스크톱 설치본 실제 설치·업데이트 후 데이터 유지 확인, 앱 아이콘(임시 "CF") 교체 (2) 데스크톱 계정 모드 로그인 세션 유지 실측 (3) 휴대폰 APK 실기기 확인 (4) 구글 로그인(OAuth 클라이언트 필요) (5) Cloud Supabase·https 배포(승인) (6) CF-07b 광고·분석·팀 초대 (7) 코드 서명 인증서(배포 전) |
| 운영 | 로컬 Supabase 60321~, 웹 3410, WordPress 8081(`docker compose -f docker-compose.wp-dev.yml up -d`) |
| 키 | 루트 `.env`, `.env.local` — git 제외 |
| 모델 | Codex 사용 한도 → reviewer 대체 |
