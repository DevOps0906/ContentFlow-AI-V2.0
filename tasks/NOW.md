# 현재 상태 (2026-11-12)

| 항목 | 상태 |
|---|---|
| 최근 완료 | 데스크톱 정식 아이콘·설치/업데이트 데이터 유지·계정 세션 유지 실측(e2e 8·9), CF-19 필수 블록·렌더러 r3, CF-D Tauri 데스크톱 W0(Windows, Next 사이드카·토큰 보호), CF-20 토스트·스낵바·⋯ 메뉴, CF-21 오버레이 패턴 확대(토스트 8개 화면, 키워드 ⋯ 메뉴, 공용 툴팁, 모바일 드로어 접근성) |
| 검증 | 단위(웹) 337, typecheck·build, W8 e2e 67, 데스크톱 실측 9건(`node apps/desktop/e2e/desktop-e2e.mjs`), cargo clippy |
| 데스크톱 | 빌드 `pwsh scripts/desktop-build.ps1` → `apps/desktop/src-tauri/target/release/bundle/nsis/`. 키 `%APPDATA%\ContentFlow\desktop.env`. 포트 34110·identifier `com.contentflow.desktop` 변경 금지. 문서 `docs/08-ops/DESKTOP_APP.md` |
| 다음 후보 | (1) 휴대폰 APK 실기기 확인 (2) 구글 로그인(OAuth 클라이언트 필요) (3) Cloud Supabase·https 배포(승인) (4) CF-07b 광고·분석·팀 초대 (5) 코드 서명 인증서(배포 전) |
| 운영 | 로컬 Supabase 60321~, 웹 3410, WordPress 8081(`docker compose -f docker-compose.wp-dev.yml up -d`) |
| 키 | 루트 `.env`, `.env.local` — git 제외 |
| 모델 | Codex 사용 한도 → reviewer 대체 |
