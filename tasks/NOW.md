# 현재 상태 (2026-11-12)

| 항목 | 상태 |
|---|---|
| 직전 완료 3 | Capacitor W0: apps/mobile(Vite+React, Android 프로젝트, 읽기 전용 화면), packages/shell-bridge, 서버 Bearer 세션(읽기 전용 GET 허용 목록·CORS·토큰 발급/갱신/폐기), 대시보드 APK 다운로드 카드(`mobile-dist/`, sha256 검증). e2e: W8 67·모바일 22 통과, 단위 293+8+8 |
| 다음 | APK 실제 빌드: Android Studio(JDK 21·SDK) 설치 + 서명 키 생성(저장소 밖·백업) 후 `apps/mobile/scripts/build-apk.mjs`. 실기기 확인 시 CF-M-003(보안 저장소) 완료. 휴대폰 접속은 dev 채널(LAN IP, `.dev` appId) 또는 https 운영 |
| 직전 완료 2 | 템플릿 10종 예시 글·"예시 보기"(이미지는 자리표시자, Gemini 이미지 모델 무료 등급 429 → 결제 후 `scripts/gen-template-images.ts`), GNB 워크스페이스 메뉴 삭제·"환경설정", 하이드레이션 시간대 고정, 로컬 Supabase 가이드 `docs/08-ops/LOCAL_SUPABASE_GUIDE.md`, cloud 스크립트 `--remote` 수정. e2e 27/27, 단위 280 |
| 직전 완료 | AI 제공자 Gemini(기본)·OpenAI 선택, 설정 "AI API" 탭(제공자·초안/검수 모델·연결 테스트). 실제 Gemini(gemini-3.5-flash) 초안 브라우저 e2e 통과, 키 노출 없음. 단위 277·typecheck·build 통과. 문서 정합화(DB 8절·ERD·WORKFLOWS) 완료. 모두 커밋·푸시 |
| 키 | 루트 `.env.local`의 `GEMINI_API_KEY`(이름 오타 JEMINI→GEMINI 수정). compose는 `.env` → `${ENV_FILE:-.env.local}` 순서로 읽음. `gemini-3.8-flash`·`gemini-flash-latest`는 이 키에서 무응답이라 기본 3.5-flash |
| 남은 단계 | (5) 클라우드 Supabase 생성·0001~0018 push — 비용·승인 필요, `scripts/supabase-cloud.ps1` 준비 (6) https 배포·운영 메일 — 승인 필요 (8) M4 파일럿 — 실제 사용자. 그 외: 블스피·블로그AI 정확한 주소, OpenAI 실키(키 없음), Gemini 비용 단가(AI_PRICE_* 미설정 → N/A) |
| 다음 작업 후보(승인 불필요) | MVP 후속: P0-04 템플릿 예제·필수 블록 차단, L02 목차·비교표. 또는 Gemini 검수(QA) 흐름 실제 호출 확인 |
| e2e | W8: `apps/web/tests/e2e/w8.mjs`(README 실행법). AI: `apps/web/tests/e2e/ai-gemini.mjs`(실제 호출, 3410 컨테이너 대상) |
| 운영 | 로컬 Supabase 60321~, 웹 컨테이너 3410·WordPress 8081 실행 중 |
| 모델 | Codex 사용 한도 → reviewer 대체. 부 모델(루나-6.1) ID 확인 대기 |
