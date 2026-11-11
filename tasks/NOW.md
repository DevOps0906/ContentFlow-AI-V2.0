# 현재 상태 (2026-11-12)

| 항목 | 상태 |
|---|---|
| 직전 완료 | W8 브라우저 검증 e2e 67건 통과(보고 `.nomad/e2e/W8_REPORT.md`, git 제외). 수정: 인증 콜백이 APP_URL 기준으로 복귀, `.table-scroll` position:relative(sr-only가 문서 폭을 키우던 문제). 단위 267·typecheck·build 통과 |
| 그 전 | Supabase 로컬(Docker)·Cloud 분리(`docs/08-ops/SUPABASE_ENVIRONMENTS.md`), W9~11 리뷰 수정(0018) |
| 다음 작업 후보 | README "남은 개발 단계" 4~8: (4) 실제 OpenAI 키 검증 — 키 필요 (5) 클라우드 Supabase 생성·0001~0018 push — 비용·승인 필요, 스크립트 준비됨 (6) https 배포·운영 메일 — 승인 필요 (7) 문서 정합화(DATABASE_SCHEMA 새 테이블, WORKFLOWS 티스토리 이미지 제외, ERD 재생성, 블스피·블로그AI 주소) — 승인 불필요 (8) M4 파일럿 — 실제 사용자 |
| 권장 다음 | (7) 문서 정합화. 이후 사용자 승인 받아 (5)(6) |
| e2e 실행 | WP: `docker compose -f docker-compose.wp-dev.yml up -d`(8081), 자격 파일(1행 사용자, 2행 앱 비밀번호) → `node apps/web/tests/e2e/start-server.mjs <cred>`(가짜 AI 4791, dev 3392) → `cd apps/web && node tests/e2e/w8.mjs <cred> <out>`. 실행 후 `git checkout -- apps/web/next-env.d.ts` |
| 운영 | 로컬 Supabase 60321~ (`pwsh scripts/supabase-local.ps1 status`), 웹 컨테이너 3410·WordPress 8081 실행 중 |
| 모델 | Codex 사용 한도 → reviewer 대체. 부 모델(루나-6.1) ID 확인 대기 |
| 미구현(MVP 후) | P0-04 템플릿 예제·필수 블록 차단, L02 목차·비교표, 외부 분석 API |
