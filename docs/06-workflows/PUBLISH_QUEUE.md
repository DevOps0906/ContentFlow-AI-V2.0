# 발행 큐 (Publishing Queue) 기능 명세 (가설)

상태: 초안 · 작업: CF-24(명세, 번호 가칭 — 팀장 확인 필요) · 상위: [WORKFLOWS.md#7 WF-06](WORKFLOWS.md), [SYSTEM_ARCHITECTURE.md#7](../02-architecture/SYSTEM_ARCHITECTURE.md), [DATABASE_SCHEMA.md#3](../03-database/DATABASE_SCHEMA.md) · 관련: [MULTI_BLOG_BILLING.md](../01-planning/MULTI_BLOG_BILLING.md), [DESKTOP_APP.md](../08-ops/DESKTOP_APP.md)

모든 숫자는 가설이며 파일럿 측정 후 확정한다(근거 없는 수치는 `미확인`).

## 1. 목적·범위
- 목적: 원격 사이트 병목(레이트 리밋·429/5xx·타임아웃·동시 전송)에서도 승인된 글을 유실·중복 없이 순서대로 전달한다.
- 현재(코드 확인): `POST /api/wordpress/draft`가 동기 전송한다. 사용자당 20회/60초 제한, `publishing` 조건부 선점, 실패 시 `publish_failed`로 두고 수동 재시도. 큐·idempotency key는 없다([WORKFLOWS.md](WORKFLOWS.md) 현재 구현 박스).
- 포함: 계정 모드 WordPress 초안 전송의 큐 처리, 재시도·백오프, 동시성 제한, 큐 화면, 취소.
- 비범위: 자동 공개(게시), Blogger/Tistory/Naver 자동 전송(수동 패키지 유지), n8n 도입, AI 생성 큐, 과금.

### 병목 원인
| 원인 | 현재 증상 | 큐의 대응 |
|---|---|---|
| 원격 레이트 리밋·429 | 즉시 실패 → `publish_failed` | `Retry-After` 존중 후 자동 재시도 |
| 5xx·일시 장애 | 즉시 실패 | 지수 백오프 재시도 |
| 타임아웃·네트워크 | 성공 여부 불명 | 원격 초안 조회 후 재시도(중복 방지) |
| 동시 전송(다수 블로그·다수 편집자) | 같은 사이트에 몰림 | 사이트별 동시 1건 직렬화 |
| 웹 요청 시간 제한 | 요청 안에서 대기 불가 | 요청은 접수만, 전송은 워커 |

## 2. 용어
| 용어 | 뜻 |
|---|---|
| 발행 작업(PublishJob) | 승인 스냅샷 1건을 원격 1곳에 전달하는 큐 행. 상태: [DATABASE_SCHEMA.md#3](../03-database/DATABASE_SCHEMA.md) |
| 원격 사이트 키(remote_key) | 같은 원격 사이트를 가리키는 식별자(블로그 계정 ID 또는 base URL 정규화값). 동시 1건의 단위 |
| 재시도 예정 | 별도 상태가 아니라 `queued` + `next_attempt_at > now()` (상태 추가 없이 화면에서만 구분) |
| 선점(claim) | 워커가 작업을 `running`으로 원자적으로 바꾸는 것 |
| idempotency key | 같은 작업의 중복 접수·중복 원격 생성을 막는 키 |

## 3. 규칙
| 항목 | 규칙 (가설 수치) |
|---|---|
| 접수 조건 | 기존 전송과 동일: 편집 권한(owner/admin/editor), 글 상태 `export_ready`·`publish_failed`, `assertDeliverable` 통과. 승인된 스냅샷만. 승인 전 접수 거부(409) |
| 접수 응답 | 즉시 `202` + job id. 전송은 하지 않는다 |
| 중복 접수 | 같은 글에 `queued/running` 작업이 있으면 새로 만들지 않고 기존 작업 반환(부분 유니크 인덱스) |
| 사이트별 동시 | `remote_key`당 `running` 최대 1건 |
| 워크스페이스별 동시 | `running` 최대 3건 (가설, 플랜별 차등은 미결) |
| 시도 기록 | 매 시도 `delivery_attempts`에 기록(0008, `failure_type` 재사용). 시도 번호는 DB 트리거가 부여 |
| 백오프 | `delay = min(base × 2^(n-1), cap)` + 지터 ±20%. base 30초, cap 15분, 최대 시도 6회 (가설) |
| Retry-After | 429/503 응답에 있으면 `max(백오프, Retry-After)`. 상한 1시간 초과 시 `needs_attention` |
| 재시도 대상 | `rate_limited`, `server`, `timeout`, `network` |
| 재시도 금지 | `auth`, `not_found`, `rejected`, `not_sendable`, `config`, `invalid_response`, `remote_state` → 즉시 `failed`(인증은 `needs_attention`) |
| 상한 초과 | 최대 시도 도달 시 `failed`, 글은 `publish_failed`. 사용자가 "다시 시도"로 새 작업 접수 |
| 불명확 응답 | 타임아웃 등 성공 여부 불명이면 재시도 전에 원격 초안 존재를 조회(WF-06 원칙) |
| 오래된 running | 선점 후 5분(가설) 하트비트 없으면 `queued`로 되돌리고 시도 1회로 센다 |

### idempotency key와 원격 갱신 규칙
- key = `workspace_id + article_id + approved_version_id` (같은 승인본 1회 접수). 승인본이 바뀌면 새 key.
- 같은 글의 원격 초안 `remote.postId`가 있으면 **새로 만들지 않고 그 초안을 갱신**한다(현 `sendDraft` 동작 유지).
- 원격이 이미 게시(공개) 상태면 **덮어쓰지 않고** `remote_state`로 실패 처리한다(현 동작 유지).
- 원격 생성 요청에 key를 메타·헤더로 남겨 재시도 시 조회 근거로 쓴다(WordPress 쪽 지원 방식은 미확인, 구현 때 확인).

### 선점 쿼리 (개념)
```sql
-- 워커 1틱: 사이트별 1건·워크스페이스별 상한을 지키며 1건 선점
select id from publish_jobs j
where status = 'queued' and next_attempt_at <= now()
  and not exists (select 1 from publish_jobs r where r.remote_key = j.remote_key and r.status = 'running')
  and (select count(*) from publish_jobs r where r.workspace_id = j.workspace_id and r.status = 'running') < 3
order by next_attempt_at, created_at
for update skip locked limit 1;
```
- 위 조회와 `running` 갱신은 한 트랜잭션(RPC 함수). 사이트별 1건은 `running`에 대한 부분 유니크 인덱스(`remote_key`)로도 이중 강제한다.

## 4. 상태 전이
| 작업 상태 | 의미 | 다음 | 글 상태(기존 규칙) |
|---|---|---|---|
| queued | 대기 또는 재시도 예정 | running, cancelled | `export_ready`/`publish_failed` 유지 |
| running | 워커가 전송 중 | draft_created, queued(재시도), failed, needs_attention | 선점 시 `publishing`(기존 조건부 갱신) |
| draft_created | 원격 초안 생성(공개 확인 전) | succeeded(운영자 확인) | `draft_created` |
| failed | 시도 소진 또는 재시도 불가 | (새 작업 접수) | `publish_failed` |
| needs_attention | 인증 만료·긴 대기 등 사람 개입 | queued(조치 후), cancelled | `publish_failed` |
| cancelled | 사용자 취소 | — | `export_ready`로 복귀 |
- `manual_pending`은 수동 패키지 경로이며 큐 대상 아님. 글 상태 전이표는 바꾸지 않는다(SQL·`lifecycle.ts` 일치 테스트 영향 없음, 확인 필요).
- 취소: `queued`만 가능. `running`은 현재 시도가 끝난 뒤 반영(원격 호출 중단 불가).
- 그림: [publish-queue-states.mmd](../diagrams/publish-queue-states.mmd)

## 5. 워커 위치 대안
| 안 | 방식 | 장점 | 단점 |
|---|---|---|---|
| A 웹 API 내 짧은 drain | 접수·화면 폴링 때 20초 이내 1~2건 처리 | 새 인프라 0, 현 구조 | 트래픽 없으면 멈춤, 서버리스 시간 제한, 백오프 정확도 낮음 |
| B 별도 워커 프로세스 | Docker 서비스가 폴링·처리 | 정확한 스케줄, 장시간 가능, 아키텍처 7절과 일치 | 운영 대상 추가, service role 필요(키 관리) |
| C Supabase cron + Edge Function | `pg_cron`이 1분마다 함수 호출 | 서버 상시 불필요, DB 가까움 | 최소 간격 1분, Edge 실행 시간 제한, 로컬 스택 재현 난이도 |
- 권장(가설): **1단계 A**(파일럿·단일 사용자, 지연 허용) → 사용자 증가·다수 블로그 때 **B**로 이전. 선점 RPC·테이블은 A/B 공통이라 이전 비용이 낮다. C는 보류.
- 그림: [publish-queue-sequence.mmd](../diagrams/publish-queue-sequence.mmd)
- 어느 안이든 브라우저는 Supabase와 직접 통신하지 않는다. A는 사용자 JWT(RLS), B·C는 서버 측 키가 필요하므로 `팀장 결정 필요`: service role 대신 선점 RPC만 실행 가능한 제한 역할.

## 6. 로컬 모드·데스크톱
| 모드 | 동작 |
|---|---|
| 로컬(브라우저 저장) | DB 큐 없음. 현행 동기 전송 유지. 실패 시 브라우저 안 "재시도 대기" 목록만(탭 열려 있는 동안 백오프 타이머, 새로고침 시 수동 재시도). 사이트별 동시 1건은 클라이언트에서 직렬화 |
| 데스크톱 로컬 | 사이드카 서버가 살아 있는 동안만 같은 인메모리 큐 처리(앱 종료 시 소실, 큐 항목은 localStorage에 남겨 다음 실행 때 수동 재개 안내). 백그라운드 상주 없음 |
| 계정 모드 | DB 큐(본 명세 전체). 데스크톱도 계정 모드면 서버 큐를 사용 |
- 로컬 모드에서도 승인 전 전송 금지·원격 게시 상태 덮어쓰기 금지는 동일하게 적용한다.

## 7. 화면 (Publishing Queue)
유형: 목록형 + 상세 패널. 진입: 사이드바 "발행 큐"(편집 권한), 글 상세의 "전송" 후 이동. 형식: [ux-patterns 2절](../../../.claude/skills/ux-patterns/SKILL.md).

| 화면 | 유형 | 구성 블록 | 상태 | 다음 화면 |
|---|---|---|---|---|
| 발행 큐 | 목록 | 상태 탭(대기·진행·재시도 예정·실패·취소) · 블로그 필터 · 작업 행(글 제목·블로그·시도 n/6·다음 시도 시각·사유) · 행 액션(취소·지금 재시도·글 열기) | 로딩, 빈 상태("대기 중인 발행이 없습니다"), 오류(저장·조회 실패), 갱신 지연 안내 | 작업 상세, 글 상세 |
| 작업 상세 | 패널/시트 | 시도 이력(`delivery_attempts`: 시각·결과·소요·실패 유형) · 원격 URL · 취소/재시도 | 진행 중(취소 지연 안내), 실패(원인 문구·조치), 인증 필요(연결 설정 링크) | 발행 큐, 설정 > 블로그 계정 |
| 글 상세 전송 버튼 | 액션 | "큐에 추가" → 토스트("대기열 N번째") | 이미 대기 중(기존 작업 표시), 권한 없음 | 발행 큐 |

| 구간 | 배치 |
|---|---|
| 모바일 ~767 | 탭은 가로 스크롤 칩, 작업은 카드 목록, 상세는 전체 화면 시트, 액션은 카드 하단 버튼 |
| 태블릿 768~1199 | 목록 1열 표 + 상세는 오른쪽 슬라이드 패널(너비 가설 360px) |
| 데스크톱 1200~ | 목록 표(열: 글·블로그·상태·시도·다음 시각) + 고정 오른쪽 상세 패널 |
- 키보드: 탭 화살표 이동, 행 Enter로 상세, Esc로 패널 닫기. 상태는 색만이 아닌 텍스트·아이콘 병기. 폴링은 5초(가설), 탭 비활성 시 중단.
- 폰트 크기는 토큰으로 구간별 지정(`DESIGN_TOKENS.md`), 이 문서에 수치 쓰지 않음.

## 8. 오류
| 코드 | 조건 | 사용자 문구 방향 |
|---|---|---|
| QUEUE_NOT_APPROVED | 승인 전·`not_sendable` | "승인된 글만 발행 큐에 넣을 수 있습니다" |
| QUEUE_DUPLICATE | 이미 대기/진행 중 | 기존 작업으로 이동 안내 |
| QUEUE_FULL | 워크스페이스 대기 상한(가설 50건) 초과 | "대기열이 가득 찼습니다. 일부를 취소하거나 잠시 후 시도" |
| QUEUE_RETRY_WAIT | 429/5xx 대기 | "사이트가 바빠 N분 뒤 자동 재시도" |
| QUEUE_AUTH | 401/403 | "WordPress 연결을 확인해주세요" (자동 재시도 안 함) |
| QUEUE_REMOTE_PUBLISHED | 원격이 이미 공개 상태 | "공개된 글은 덮어쓰지 않습니다" |
| QUEUE_EXHAUSTED | 최대 시도 소진 | "자동 재시도가 끝났습니다. 원인 확인 후 다시 시도" |

## 9. 데이터 (초안, 마이그레이션 아님)
| 테이블 | 핵심 컬럼 | 비고 |
|---|---|---|
| publish_jobs | id, workspace_id, article_id, approved_version_id, channel(wordpress), remote_key, status, idempotency_key(unique), attempt_count, max_attempts, next_attempt_at, locked_at, last_failure_type, remote(postId,url), created_by, created_at, updated_at | RLS: 멤버 조회, 편집 권한 접수·취소. 워커 갱신은 RPC/제한 역할만. 부분 유니크: (article_id) where status in (queued,running), (remote_key) where status=running. 인덱스: (status, next_attempt_at), (workspace_id, status) |
| delivery_attempts (기존 0008) | + job_id(nullable) | 시도 이력 재사용. 컬럼 추가는 별도 마이그레이션 |
| article_state_events (기존) | 변경 없음 | 글 상태 전이 기록 유지 |
- 저장 데이터: 글 ID·원격 URL·실패 유형만. 자격 증명·본문은 작업 행에 복사하지 않는다(승인 스냅샷 참조).

## 10. API (초안)
| 메서드·경로 | 입력 | 출력 | 권한 | 오류 |
|---|---|---|---|---|
| POST /api/publish/jobs | articleId | 202 {job} | editor 이상, 같은 출처 | 400, 403, 409(QUEUE_*), 429 |
| GET /api/publish/jobs | status?, blogId? | {jobs[], nextPollMs} | 멤버 | 401 |
| GET /api/publish/jobs/:id | — | {job, attempts[]} | 멤버 | 404 |
| POST /api/publish/jobs/:id/cancel | — | {job} | editor 이상 | 409(진행 중) |
| POST /api/publish/jobs/:id/retry | — | {job} | editor 이상 | 409 |
| POST /api/publish/drain (안 A) | — | {processed} | 서버 내부·내부 토큰 | 401 |
- 기존 `/api/wordpress/draft`는 큐 도입 후 내부 전송 함수로만 사용하고 직접 호출 경로는 단계적으로 폐지(호환 기간은 미결).
- 위협 메모(노출 면 = 신규 API + 워커):

| 위협 | 대응 |
|---|---|
| 인가 우회·타 워크스페이스 작업 조회 | RLS + 모든 쿼리 workspace 조건, 교차 테넌트 테스트 |
| 큐 폭주·비용 증폭(스팸 접수) | 사용자별 접수 제한(기존 `rate_limit_hit` 재사용) + 대기 상한 |
| 승인 우회·변조 본문 전송 | 접수 시 글 ID만 수신, 승인 스냅샷 해시 재검증 |
| drain 엔드포인트 남용 | 내부 토큰·같은 출처 외 거부, 처리량 상한 |
| 워커 키 유출 | service role 금지 원칙 유지, 제한 역할·환경 변수만, 로그에 비밀 금지 |
| 실패 메시지의 원격 정보 노출 | 사용자에게는 분류된 문구만, 원문은 서버 로그 |

## 11. 부정 시나리오
| 시나리오 | 대응 |
|---|---|
| 같은 글 더블 클릭·두 탭 접수 | 부분 유니크로 기존 작업 반환, 원격 초안 1개 |
| 워커 2개가 동시 선점 | `SKIP LOCKED` + 사이트별 유니크, 한쪽만 성공 |
| 전송 성공 후 DB 저장 실패 | 작업 `needs_attention`, 원격 postId 안내, 재시도는 같은 초안 갱신 |
| 대기 중 글 수정 → 승인 해제 | 접수 작업 자동 취소 또는 전송 직전 재검증 실패(`not_sendable`) |
| 대기 중 원격에서 사람이 공개 | `remote_state` 실패, 덮어쓰지 않음 |
| 워커 크래시(running 고착) | 5분 가설 후 `queued` 복구 |
| 인증 만료 상태에서 큐 가득 | 같은 `remote_key` 작업 일괄 `needs_attention`, 재연결 후 재개 |
| 워크스페이스 멤버 권한 강등 | 전송 시점에 권한 재확인, 불가 시 `cancelled` |
| 데스크톱 앱 종료 | 로컬 큐 소실 허용, 재실행 시 수동 재개 안내 |

## 12. 인수 조건
- [ ] 접수는 202로 즉시 반환, 승인 전 글은 큐에 들어가지 않는다
- [ ] 같은 글 중복 접수 시 작업 1개·원격 초안 1개
- [ ] 같은 `remote_key`에 `running` 2건이 동시에 존재하지 않는다(동시 선점 테스트)
- [ ] 워크스페이스별 동시 상한 초과 시 대기 유지
- [ ] 429 + `Retry-After` 응답에서 지정 시간 이전 재시도하지 않는다
- [ ] 401/403은 자동 재시도하지 않고 `needs_attention`
- [ ] 최대 시도 소진 시 `failed` + 글 `publish_failed`, 시도 이력이 `delivery_attempts`에 남는다
- [ ] 재시도 시 기존 `remote.postId` 초안을 갱신하고, 원격이 공개 상태면 덮어쓰지 않는다
- [ ] 화면 3구간에서 5개 상태 탭·빈 상태·오류·키보드 조작 확인
- [ ] 로컬 모드는 기존 동기 전송과 동작이 같고 DB 큐를 쓰지 않는다
- [ ] 교차 테넌트 RLS 테스트, `supabase/tests/run.ps1` 통과

## 13. 미결정 사항 (사용자 결정)
| 항목 | 권장안 | 상태 |
|---|---|---|
| 워커 위치 | 1단계 A(웹 내 drain) → 필요 시 B(별도 워커), C 보류 | 팀장 결정 필요 |
| 워커 DB 권한 | service role 대신 선점 RPC 전용 제한 역할 | 팀장 결정 필요(보안, 위험 높음) |
| 워크스페이스 동시 상한 | 3건, 플랜별 차등은 파일럿 뒤 | 미확인(근거 필요) |
| 최대 시도·백오프 수치 | 6회, base 30초, cap 15분 | 가설, 원격 사이트 실측 필요 |
| 글 상태 전이 변경 여부 | 변경 없음(큐는 job 상태로 표현, 글은 기존 규칙) | 팀장 확인 |
| 기존 직접 전송 API | 큐 안정화 후 폐지, 그 전엔 병행 | 팀장 결정 필요 |
| idempotency 원격 표식 방식 | 구현 때 WordPress 지원 확인 | 미확인 |
| 로컬 모드 큐 범위 | 인메모리·수동 재개만 | 팀장 결정 필요 |
| 대기 상한·폴링 주기 | 50건 / 5초 | 가설 |

## 14. 작업 (가칭)
| ID | 내용 | 상태 | 위험 |
|---|---|---|---|
| CF-24a | `publish_jobs` 마이그레이션·RLS·선점 RPC·테스트(교차 테넌트·동시 선점) | 대기 | 높음 |
| CF-24b | 접수·조회·취소 API, 백오프·Retry-After 순수 함수와 단위 테스트 | 대기 | 보통 |
| CF-24c | 워커(안 A drain) + 기존 `sendDraft`·`trackDelivery` 연결, 멱등 재시도 | 대기 | 높음 |
| CF-24d | 발행 큐 화면 3구간(상태 탭·상세 패널·빈/오류 상태) | 대기 | 낮음 |
| CF-24e | 로컬·데스크톱 인메모리 큐, README·`tasks/NOW.md` 갱신 | 대기 | 보통 |

## 15. 확정 결정 (2026-11-13)
| 항목 | 결정 |
|---|---|
| 워커 위치 | 1단계 A(웹 내 짧은 drain). B(별도 워커)는 후속, C 보류 |
| 워커 권한 | 요청 사용자 세션으로 security definer 선점 RPC만 호출. service role 사용 안 함 |
| 기존 `/api/wordpress/draft` | CF-24에서 화면 전송을 큐 접수로 교체. 라우트는 내부에서 큐를 호출하는 호환 경로로 유지 |
| 로컬 모드 | §6 권장안(인메모리·수동 재개) |
| 글 상태 전이표 | 변경 없음. 큐 상태는 job 쪽에만 둔다(`lifecycle.ts`·0002 전이표 불변) |
| 재시도 예정 | 새 상태 없이 `queued` + `next_attempt_at` |
| 작업 번호 | CF-24 |

## 16. 착수 전 검토 반영 (challenger, 2026-11-13) — §3·§4·§6·§9·§10과 다르면 이 장이 우선
| 항목 | 확정 규칙 |
|---|---|
| 원격 키 | `remote_key` = 접수한 서버 env WordPress base URL 정규화값(소문자 호스트·끝 `/` 제거). 블로그 ID 아님. 자격증명은 현행 env 하나 유지(블로그별 자격증명은 범위 밖) |
| drain 범위 | `claim_publish_job()` RPC(security definer, search_path 고정, set_config 금지)는 **호출자 워크스페이스 중 호출자가 발행 권한(owner·admin·editor)을 가진 곳**의 job만, 그리고 인자 `p_remote_key`와 같은 job만 선점한다. 같은 remote_key의 running은 워크스페이스당 1건(§18, 0021에서 전역 → 워크스페이스 단위), 워크스페이스 동시 상한(가설 3). 반환은 job id·article id·approved_version_id뿐, 본문은 앱이 사용자 세션으로 읽는다 |
| drain 트리거 | GET은 부작용 없음. drain은 `POST /api/publish/drain`(sameOrigin, 사용자 세션)만. 요청당 job 최대 1건 동기 처리(sendDraft 최악 45초, maxDuration 60). 큐 화면은 자기 워크스페이스에 queued가 있을 때 5초마다 drain POST. 새 내부 토큰 없음(§10의 내부 토큰 폐기) |
| 접수 | `POST /api/publish/jobs` → 202 `{job}`. 호환 경로 `POST /api/wordpress/draft`(계정 모드)는 접수 후 같은 요청에서 그 job 1건 drain을 시도해 끝나면 기존과 같은 200 `{article, created}`, 원격 사용 중·재시도 예정이면 202 `{job}`. `workspace.tsx`는 202를 처리한다. localFlow는 동기 그대로 |
| 글 상태 | 전이표 불변. 선점: export_ready·publish_failed → publishing(기존 조건부 갱신, RPC 안에서 같은 트랜잭션). 성공 → draft_created. 재시도 예정·실패·needs_attention → publish_failed(합법). 다음 선점은 publish_failed → publishing. 취소는 queued만 가능하고 글 상태는 건드리지 않는다(이미 export_ready/publish_failed). §4 "export_ready로 복귀" 폐기 |
| 고착 회수 | running이 `locked_at`+5분(가설, 최악 45초의 6배 이상) 지나면 다음 claim RPC가 job→queued(attempts 유지), 글 publishing→publish_failed(actor = 회수를 일으킨 호출자, note `stale_reclaim`). 마이그레이션 시점의 job 없는 publishing 글은 건드리지 않는다(현행과 동일, 운영 메모) |
| 유일성 | 전체 unique 없음. 부분 unique `(article_id) where status in ('queued','running','needs_attention')`. `idempotency_key`는 기록·조회용 비유일 컬럼. 원격 멱등성은 기존 slug 조회(wordpress.ts) — 헤더·메타 방식은 범위 밖 |
| 버전 변경 | claim 시 글의 approved_version_id ≠ job의 값이거나 글이 export_ready·publish_failed가 아니면 job → cancelled(reason `stale_version`/`article_changed`), 다음 job 시도. 새 승인본 접수 시 같은 글의 queued·needs_attention job은 cancelled(`superseded`), running이면 `QUEUE_DUPLICATE` |
| 시도 수 | 진실은 `publish_jobs.attempts`. delivery_attempts는 기록용(유실 가능) |
| 권한 | viewer·reviewer는 큐 조회만, drain·접수·취소 불가(RPC가 거부). 모바일 bearer 프록시에 `/api/publish/*` 미허용 |
| 로컬 모드 | 큐 없음 — 현행 동기 전송 유지(§6 인메모리 큐 폐기). 데스크톱 계정 모드 사이드카는 자기 env의 remote_key job만 drain |

## 17. 구현 메모 (0020)
- 취소: queued와 needs_attention 모두 가능(needs_attention을 막으면 부분 unique 때문에 새 접수가 불가). running은 불가(`JOB_RUNNING`).
- 고착 회수는 호출자가 발행 권한을 가진 워크스페이스 안에서만 상태를 바꾼다. remote 직렬화 판정은 stale(5분 초과) running을 세지 않는다(0021부터 판정 자체가 워크스페이스 안에서만 이뤄진다). 회수 기록은 audit_logs `publish.stale_reclaim`.
- retry 시 attempts ≥ max면 failed(`QUEUE_EXHAUSTED`), retry_at이 1시간 넘게 뒤면 needs_attention. success는 job `draft_created` + 글 publishing→draft_created(원격 postId·URL 저장은 앱이 finish 전에 한다).
- 가설 상수(마이그레이션 하드코딩): 대기 상한 50, 워크스페이스 running 3, stale 5분, max_attempts 6. RPC 시그니처는 0020 참조.
- `delivery_attempts.job_id` 연결은 후속.
- drain은 선점한 job의 `workspace_id` 기준으로 본문 조회·전송 기록·remote 저장을 한다(활성 워크스페이스와 무관).
- 같은 승인본을 다시 접수하면 needs_attention job은 queued로 되살아난다(attempts 0, last_error 비움). 자격증명 수정 후 '전송'이 실제로 다시 보내게 하기 위함(contract 리뷰 🔴 반영).
- 호환 경로에서 선점 뒤 서버 오류(5xx)는 202가 아니라 502 + "최대 5분 뒤 큐에서 재시도"로 응답한다(job은 stale 회수 대기).
- 전달 가능 확인 RPC 자체의 실패는 `DeliveryError.transient`로 표시해 재시도한다(유형은 unknown 유지).
- 알려진 위험(테넌트 간 점유): §18(0021)에서 해결 — 직렬화를 워크스페이스 단위로 변경.
- env WordPress 주소를 바꾸면 기존 queued job의 remote_key가 달라져 선점되지 않는다. 화면에서 취소 후 다시 접수한다(운영 메모).

## 18. 공유 사이트 점유 방지 (0021, 2026-11-13 확정) — §15·§16의 "사이트당 동시 1건"보다 우선
| 항목 | 확정 규칙 |
|---|---|
| 위협 | 발행 권한이 있는 사용자가 PostgREST로 `claim_publish_job`만 반복하고 finish를 부르지 않으면, 같은 remote_key를 쓰는 모든 테넌트가 고착 판정(5분)마다 막혔다. remote_key는 접수 때 호출자가 정하므로 남의 사이트 주소로도 가능했다. service role 금지 때문에 RPC 실행을 서버 전용으로 회수할 수 없다 |
| 결정 | 사이트 직렬화 단위를 **(워크스페이스, remote_key)** 로 바꾼다. 다른 워크스페이스의 running·queued는 claim 판정에 전혀 쓰지 않는다 → 테넌트 간 점유·정보 측면 채널 모두 제거. 사용자 결정(2026-11-13) |
| 기각한 안 | 차례 지키기(방치된 queued가 직전 선점자를 무기한 정지, 다중 워크스페이스로 우회), 고착 회수 → needs_attention(재접수 revive로 공격자 비용 0, 정상 크래시만 사람 개입), 고착 2분(데스크톱 사이드카의 Supabase 호출에 타임아웃 없음). challenger 검토 |
| 대가 | 여러 워크스페이스가 같은 WordPress로 보내면 동시 요청이 생길 수 있다. 429·5xx·Retry-After는 기존 백오프가 처리 |
| 남는 위험 | 한 사용자가 자기 워크스페이스 안에서 자기 발행을 막는 것은 막지 않는다(자기 손해). 워크스페이스 동시 3건·대기 상한 50·고착 5분·자동 재대기는 그대로 |
| 형식 | `0021_publish_queue_per_workspace.sql`: `create or replace function claim_publish_job`만(시그니처·반환형·권한 불변). 사이트 advisory lock 제거, 워크스페이스 lock 유지. rls.sql: A 실행 중 B가 같은 사이트 선점 가능 시험 |
