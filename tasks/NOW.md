# 현재 상태 (2026-11-12)

| 항목 | 상태 |
|---|---|
| 직전 완료 | W9~11 리뷰 수정(마이그레이션 0018) 커밋. typecheck·단위 테스트 257·build·DB 규칙 테스트(run.ps1) 통과. 로컬 Supabase는 `db reset`으로 0018까지 재적용(이전 로컬 데이터 삭제됨) |
| 다음 작업 | W8 브라우저 검증 — `tasks/PLAN_MVP_REMAINING.md#검증 묶음`. 팀·인증·수익·AI 검수·W9~11 새 기능 흐름, 키보드, 저장 실패, 3구간 화면, 실제 WordPress 컨테이너로 slug 선조회·유지 확인. AI는 가짜 서버 |
| W8 출발점 | 미완성 스크립트 `apps/web/tests/e2e/`(커밋 제외, 로컬에만). 먼저 내용 확인 후 이어서 작성 |
| 위험도 | 낮음~보통(테스트 코드만). 실패 발견 시 수정은 보통 |
| 이후 | 운영 DB(클라우드 Supabase)·https 배포·운영 메일 → 사용자 승인 필요. 실제 OpenAI 키 검증(키 없음). 문서 정합화(DATABASE_SCHEMA 새 테이블, WORKFLOWS 티스토리 이미지 제외, ERD 재생성). M4 파일럿 |
| 0018 요점 | `cf_norm_key`(NFKC→공백 6종 축약→btrim→lower) JS `normalizePhrase`와 동일. 보관 blog 새 연결·기록 차단(`assert_blog_active`, anon/authenticated 실행권 회수), 중복 키는 상한 전 통과, advisory lock. 한계: lower() Σ·İ 차이 수용 |
| 모델 | Codex 사용 한도 → reviewer 대체. 부 모델(루나-6.1) ID 확인 대기 |
| 운영 | 로컬 Supabase 포트 60321~ (`npx supabase stop`), 웹 컨테이너 3410 |
| 미구현(MVP 후) | P0-04 템플릿 예제·필수 블록 차단, L02 목차·비교표, 외부 분석 API, 블스피·블로그AI 정확한 주소 |
