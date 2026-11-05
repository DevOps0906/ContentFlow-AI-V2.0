# ContentFlow AI — 작업 지침

<!-- codebase-memory-mcp:start -->
구조 탐색에는 설치된 codebase-memory 스킬과 커버리지 확인을 사용한다. 미인덱싱 범위는 소스를 직접 확인한다.
<!-- codebase-memory-mcp:end -->

## 제품과 구현

- 제품 정본: `docs/01-planning/PRD.md`, `docs/01-planning/MONETIZATION_STRATEGY.md`.
- 구현은 `apps/web`: Next.js 16 App Router, React 19, TypeScript, CSS 토큰, lucide-react.
- 명령: `npm run dev`, `npm run typecheck`, `npm test`, `npm run build`.
- Supabase 미설정 시 브라우저 저장(로컬 모드), 설정 시 이메일 로그인 + DB 저장(계정 모드)이다. 연결되지 않은 AI·CMS·광고 API를 연결되었다고 표시하지 않는다.
- 상태 규칙의 최종 강제는 DB 트리거(`supabase/migrations/0002_*`)다. `lifecycle.ts`를 바꾸면 SQL 전이표도 같이 바꾸고(일치 테스트가 있다) `supabase/tests/run.ps1`을 실행한다.
- 브라우저는 Supabase와 직접 통신하지 않는다. service role 키를 앱에 넣지 않는다.
- 원고 수정은 승인을 해제한다. 본문/근거 URL 없는 승인, 승인 전 HTML export를 차단한다.
- 미리보기는 React 텍스트, export는 HTML escape를 사용한다. 임의 script를 실행하지 않는다.
- 실제 수익 데이터가 없으면 N/A로 표시한다.

## Codex 팀

- 주 모델: `gpt-6.1-sol`. 부 모델 요청: 사용자 표현 `루나-6.1`, 정확한 지원 ID 확인 대기.
- ID 확인 전 임의 모델 대체나 하위 에이전트 실행 금지.
- `.codex/config.toml`, `.codex/agents/*.toml`, `.codex/CODEX_TEAM.md`가 프로젝트 구성이다.
- NOMAD `codex_team.py init . --worker-model <ID>`로 확인된 ID를 적용하고 새 세션에서 활성화한다.
- 역할: nomad_scout / nomad_designer / nomad_builder / nomad_tester / nomad_reviewer.
- 팀장이 파일 소유·근거·완료 기준을 지정한다. 최대 3개 독립 작업, 깊이 1.
- 다른 작업자가 있으므로 타인의 변경을 되돌리지 않는다. 같은 파일 동시 수정 금지.

## 문서와 검증

- UI는 3구간 반응형, 키보드 접근, 빈 상태, 저장 실패를 처리한다.
- 기능 변경 시 README의 구현 상태/콘텐츠 바로가기와 `tasks/NOW.md`를 갱신한다.
- 비밀키·브라우저 데이터·node_modules·.next·.cache를 커밋하지 않는다.
- 커밋 전 타입 검사, 의미 있는 테스트, production build, diff check를 수행한다.
