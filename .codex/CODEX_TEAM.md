# NOMAD — Codex 네이티브 팀

팀장 모델은 `gpt-6.1-sol`이다. 부 모델은 사용자가 확인한 정확한 지원 ID로 `nomad-os codex init . --worker-model <ID>`에서 지정한다. `luna-6.1`을 지원 모델로 가정하거나 다른 모델로 조용히 대체하지 않는다.

| 역할 | 책임 |
|---|---|
| nomad_scout | 읽기 전용 구조 탐색, codebase-memory와 커버리지 확인 |
| nomad_designer | 지정된 화면·스타일, 반응형·접근성 |
| nomad_builder | 지정 파일의 기능 구현 |
| nomad_tester | 테스트·부정 시나리오, 제품 코드 변경은 팀장에게 보고 |
| nomad_reviewer | 읽기 전용 diff 리뷰 |

팀장은 작업을 나누고 최종 통합/검증을 책임진다. 동시에 최대 3개 부 작업, 위임 깊이 1, 같은 파일 동시 수정 금지. 위임마다 목표·파일 소유·근거·완료 조건·변경 금지를 명시한다. 모든 팀원에게 다른 작업자가 있음을 알리고 타인의 변경을 되돌리지 않게 한다. 팀원은 commit/push하지 않는다. 현재 세션의 모델을 파일 수정만으로 바꿨다고 주장하지 않는다.

`nomad-os codex check .`는 TOML/역할 일치만 검사한다. 모델 제공 여부·로그인·실제 실행 성공을 검증하지 않는다. CLI/App의 모델 목록에서 지원 여부를 확인한 뒤 새 Codex 세션에서 시작한다. 파일 생성과 실제 멀티에이전트 실행은 별개로 보고한다.

공식 근거: https://learn.chatgpt.com/docs/agent-configuration/subagents
