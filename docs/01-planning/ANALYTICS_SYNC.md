# 광고·분석 API 동기화 (기능 명세, 초안 r2)

버전: **r2** (2026-11-15, r1 리뷰·공격 결과와 사용자·팀장 결정 반영) · 상태: 초안 · 작업: CF-07b(구현은 Google OAuth 클라이언트 발급 후) · 상위: [MONETIZATION_STRATEGY.md#6](MONETIZATION_STRATEGY.md), [PRD.md#8](PRD.md), [PRD.md#11](PRD.md)
현재 상태: **아무 API도 연결되어 있지 않다.** 이 문서는 근거 문서이며, 연결 전에는 화면·문구가 "연결됨/자동 수집"을 말하지 않는다. 지금 동작하는 것은 CSV 가져오기와 수동 입력뿐이다(`revenue.ts`, `blog-metrics.ts`).

## 1. 목적·범위
- 목적: 운영자가 Google 계정을 읽기 전용으로 연결하면 GSC·AdSense·(선택) GA4 지표를 **로그인한 세션에서** 가져와, CSV와 같은 저장 계약에 **출처가 구분된 행**으로 넣는다. 화면·계산·N/A 규칙은 CSV 입력과 동일하다.
- 포함: OAuth 연결·해제, 출처별 수집(세션 기반 "지금 동기화" + 화면이 열려 있을 때 폴링), 재조회 교체, 실패/지연 표시, 연결 상태 화면.
- 비범위:

| 비범위 | 이유 |
|---|---|
| **무인 예약 실행(cron)·새 비밀 주체(전용 DB 역할·Edge Function)** | 후속 과제. 도입 시 별도 challenger 검토 필요(결정됨, §8 D2) |
| 쓰기 scope(광고 설정·색인 요청·속성 변경) | 읽기 전용만 요청 |
| 확정 월 정산액 자동 수집 | API 값은 예상 수익, 확정은 CSV/수동([MONETIZATION_STRATEGY.md#6](MONETIZATION_STRATEGY.md)) |
| 글별 수익 귀속 모델·ROI 계산 | 기존 `pageSummaries` 규칙 유지, 이 문서는 입력만 |
| 로컬 모드·데스크톱 로컬 | 서버·DB가 없어 OAuth 토큰을 안전히 둘 곳이 없음 |
| 네이버·티스토리 통계 API | 공식 수집 경로 미확인, 기존 수동/CSV 유지 |
| 색인 상태 확인(URL Inspection) | 검색 데이터 수집 ≠ 색인 확인 |
| GSC `query` 차원 수집 | 행 수 폭증(§4 상한). 필요 시 상위 N만 후속 검토 |

## 2. 출처별 지표·차원
공식 문서로 지표·차원·제공 범위를 확인한 뒤에만 열거한다. 아래는 사용 후보이며, **실제 계정에서 조합이 허용되는지는 `미확인`**(연결 후 1회 확인 필요). 출처 순서(결정됨): **GSC → AdSense → GA4**.

| 출처 | 가져올 값(후보) | 차원(후보) | 저장 위치·source/tool 값 | 공식 문서 |
|---|---|---|---|---|
| GSC 검색 분석 | clicks, impressions, ctr, position | date, page | `blog_metric_snapshots` tool `gsc-api` (CSV는 기존 `gsc`) | [searchanalytics.query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query) |
| AdSense 보고서 | ESTIMATED_EARNINGS, PAGE_VIEWS, IMPRESSIONS, CLICKS | DATE, PAGE_URL(계정별 `미확인`) | `revenue_rows` source `adsense-api`, status `estimated` | [Metric](https://developers.google.com/adsense/management/reference/rest/v2/Metric), [Dimension](https://developers.google.com/adsense/management/reference/rest/v2/Dimension), [reports.generate](https://developers.google.com/adsense/management/reference/rest/v2/accounts.reports/generate) |
| GA4 Data API (선택) | 세션·조회수·참여 지표(확정 목록 `미확인`) | date, pagePath | `blog_metric_snapshots` tool `ga4-api`(신규 값) | [Data API v1](https://developers.google.com/analytics/devguides/reporting/data/v1) |

고정 규칙(PRD#11과 같다, 재서술 최소화):
- AdSense `ESTIMATED_EARNINGS`는 항상 `status=estimated`. API로 `finalized`를 만들지 않는다.
- 페이지 RPM의 분모는 **같은 AdSense 보고서의 PAGE_VIEWS**만. GA4 조회수는 분모·분자 어디에도 섞지 않고 별도 행으로만 보인다.
- 사이트 총액 행과 페이지별 행을 한 범위에 함께 저장하지 않는다. 범위당 granularity 하나(기존 `page=''`이 사이트 수준).
- 도구가 다른 값은 더하거나 환산하지 않는다(0017 원칙 유지).
- **통화·보고 시간대 규칙은 AdSense에만 적용**한다: 응답에서 받아 저장하고 없으면 가져오기를 실패 처리, 추정하지 않는다. 해당 요청 파라미터·응답 필드명은 `미확인`(공식 확인 필요). GSC에는 통화가 없고 시간대 규칙을 적용하지 않는다(날짜 기준·시간대 표기는 `미확인`).
- **API 행과 CSV 행은 source(tool) 값으로 분리**한다(`gsc-api`·`adsense-api`·`ga4-api`). provenance 컬럼은 추가하지 않는다. 기존 키가 그대로 출처별로 갈린다: 0012 기간 트리거·`revenue_rows` 유니크·`rowKey`(`revenue.ts:81`, source 소문자 포함)·0017 `measurement_key`·`summarize`(`revenue.ts:255`, source별 그룹). PRD#8의 값 상태(api/csv/manual/model)와는 source 접미사 `-api`로 대응하고, value_status·granularity는 기존 `status`·`page=''`가 대신한다.
- **화면 요약은 CSV와 API를 합산하지 않는다.** 같은 사이트·기간에 둘 다 있으면 나란히 표시하고 안내 문구를 붙인다.
- 새 필드(§5): `coverage(complete/partial)` — partial 행은 완전 합계·RPM에 넣지 않고 "부분 데이터"로 표시, `sync_run_id`. 원본 파일 해시에 해당하는 값으로 API 행은 `sync_run_id` + 요청 범위·요청 시각(`analytics_sync_runs`)을 저장한다.

## 3. OAuth 흐름
| 항목 | 결정 |
|---|---|
| 방식 | 서버 측 Authorization Code(웹 서버 앱), `access_type=offline`. 브라우저에는 토큰이 오지 않는다 |
| state·PKCE | `state`·PKCE verifier는 **httpOnly 쿠키(짧은 만료)**에 둔다. 콜백에서 ① state 일치(1회용) ② 시작한 사용자 = 현재 세션 사용자 ③ 현재 owner/admin 재확인. 하나라도 실패하면 코드 교환 없이 거부 |
| 최소 scope | GSC `webmasters.readonly`, AdSense `adsense.readonly`, GA4 `analytics.readonly`. 출처별 **따로 동의**(점진적 권한). 쓰기 scope 금지. **`webmasters.readonly`는 해당 Google 계정의 전체 사이트를 읽는 권한**이다. `external_ref` 허용 목록은 앱 내부 제한일 뿐 Google 쪽 범위를 줄이지 못한다(동의 화면·문구에 정직하게 안내) |
| credential 단위 | **grant = (워크스페이스, Google 계정 sub, 클라이언트)** 하나. 여러 연결(속성·계정)이 한 grant에 매달린다. refresh token은 grant 단위로 1개 저장 |
| 연결 단위 | 연결 1건 = (워크스페이스, 출처, 외부 대상) + grant 참조. GSC·GA4 속성은 `blog_id`에 연결, AdSense 계정은 워크스페이스 연결 + 사이트/블로그 매핑 |
| 권한 | 연결·해제·동기화 실행: owner·admin. 조회: 멤버. 동기화는 **누른 세션 사용자** 권한으로 실행된다(서버 작업 주체 없음) |
| 토큰 저장 | refresh token만 저장(access token은 메모리·단기). 앱 서버 AES-GCM 암호문만 DB에(§5 0023, §8 D2) |
| 폐기 | **해제는 연결만 끊는다.** 같은 grant를 쓰는 연결이 0개가 될 때만 Google revoke 호출 후 토큰 삭제. **revoke 실패 시 토큰을 보관하고 재시도**하며 사용자에게 Google 계정 권한 페이지에서 직접 철회하도록 안내한다(로컬 삭제 금지). 이미 가져온 데이터는 §8 D4. Google 쪽 철회는 다음 동기화의 `invalid_grant`로 감지해 `needs_reauth` |
| 멤버 변경 | 멤버 제거·owner/admin 아님으로 강등 시, 그 사람이 만든 grant에 매달린 연결은 `needs_reauth`. 실행은 `memberships` update/delete 트리거(같은 트랜잭션, 지연 확인 없음) |
| 상태 | `pending → active → needs_reauth / revoked / error`. 재동의 없이는 `active`로 못 돌아간다 |
| 한도·개발 단계 | Google 계정×클라이언트당 refresh token 100개(D9), Testing 상태 refresh token 7일 만료·민감 scope는 공개 전 앱 검증(D7). 2026-11-15 공식 문서 확인 |

## 4. 동기화
| 항목 | 규칙 |
|---|---|
| 실행 | **세션 기반만.** "지금 동기화" 버튼(연결당 쿨다운) + 연결/기록 화면이 열려 있을 때 폴링(발행 큐 `publish-queue.tsx:94-101` 패턴). 화면이 닫혀 있으면 동기화되지 않는다 — 화면에 "열려 있을 때만 갱신" 명시. 브라우저가 Google을 직접 호출하지 않는다(앱 서버 경유). 무인 cron은 비범위 |
| 범위 | 최초: 과거 90일(D3). 이후: 마지막 성공 범위 끝 − 재조회 창 ~ 어제 |
| 재조회 창 | 최근 며칠은 값이 늦게 확정될 수 있어 겹쳐 다시 가져온다(3일, D3) |
| 재조회 교체 | 연결별로 이전 API 실행의 **겹치는 날짜 행만** 지우고, 그 실행 행들의 `period_end`를 새 범위 시작 전날로 줄인 뒤 새 범위를 삽입한다(앞 구간 재조회 없음, 각 행의 기간은 실제 조회 범위와 일치 — 0012 기간 의미 유지). 삭제 대상은 `source/tool = *-api AND connection_id`로 한정, CSV·수동 행은 절대 대상 아님. **단일 트랜잭션 RPC**(부분 삽입 상태 없음) |
| CSV와 충돌 | source가 달라 별도 행. 덮어쓰지 않고 합산하지 않으며 화면에 나란히 표시(§2, D5) |
| GSC 수집 범위 | 차원은 **page × 일**만. query는 비범위. 최초 90일 × 페이지 수가 워크스페이스 행 상한(0017: **30,000행**, `blog_metric_snapshots` 트리거)을 넘을 것으로 **사전 계산되면 실행 전에 차단**하고 사유·줄이는 방법(기간·페이지 수)을 안내한다. 부분 삽입 후 실패 금지 |
| 쿼터 | 출처별 요청·행 상한: [GSC 한도](https://developers.google.com/webmaster-tools/limits), [GA4 쿼터](https://developers.google.com/analytics/devguides/reporting/data/v1/quotas), AdSense 한도 `미확인`. 페이지네이션·지수 백오프·연결당 동시 1건. 상한 도달 시 `delayed` |
| 실패 | 모든 시도는 `analytics_sync_runs`에 기록: 상태 `succeeded/partial/failed/delayed`, 요청 범위, 요청 시각, 행 수, 오류 코드(토큰·응답 본문 제외) |
| **0과 구분** | 실패·지연·미연결·응답 없음 → 행을 만들지 않고 `N/A`+사유. 응답 성공이고 값이 실제 0일 때만 0 저장. `partial`은 `coverage=partial`, 합계에서 완전 데이터로 취급하지 않음 |
| 연속 실패 | N회(가설 3) 연속 실패 시 연결 `error`, 화면 배너, 자동 재시도(폴링) 중단 |
| created_by | 동기화를 누른 **세션 사용자(`auth.uid()`)**. 연결자(`connected_by`)는 연결 테이블에 따로 둔다 |
| 감사 | 연결·해제·동기화 실행은 `audit_logs`(토큰·응답 본문 X) |

## 5. 데이터 모델 변경안
기존 테이블 재사용: `revenue_rows`(0005·0012), `blog_metric_snapshots`(0017). 새 읽기 경로를 만들지 않는다. **provenance 컬럼은 추가하지 않는다**(§2).

| 번호(가안) | 변경 | RLS·원칙 |
|---|---|---|
| 0022 `analytics_connections` | `id, workspace_id, blog_id(null 허용), grant_id, provider, external_ref, scopes, status, connected_by, last_attempt_at, last_success_at, last_error_code, created_at` | select: 멤버. insert/update/delete: owner·admin. 토큰 컬럼 없음. `(workspace_id, provider, external_ref)` 유니크. 복합 FK로 같은 워크스페이스 블로그만 |
| 0023 `analytics_credentials`(grant) | `grant_id, workspace_id, google_sub, client_id, ciphertext, key_version, created_by, updated_at` | RLS 활성 + **authenticated 직접 정책 없음**. 접근은 아래 RPC로만 |
| 0023 읽기·쓰기 RPC | `store_credential`, `read_credential` 등 | security definer, search_path 고정, 내부에서 세션 사용자 `is_member`(owner/admin) 확인, **EXECUTE는 authenticated만(anon·public revoke)** |
| 0024 `analytics_sync_runs` | `id, connection_id, workspace_id, requested_by, range_start, range_end, requested_at, status, rows_written, error_code, started_at, finished_at` | select: 멤버. 쓰기: RPC 경유. 보관 상한(가설 90일·연결당 N건) 트리거 |
| 0025 저장 계약 확장 | `revenue_rows`에 `coverage`, `sync_run_id`, `connection_id` 추가. `blog_metric_snapshots`에 같은 3열 추가, tool 체크에 `gsc-api`·`ga4-api` 추가. `adsense-api`는 tool이 아니라 `revenue_rows.source` 값(0005 길이 체크만, 스키마 변경 없음) | 기존 행은 기본값으로 호환. 상태 규칙·상한 트리거 유지. 0017 헤더 코멘트 "Never fetched" 갱신. `blog-metrics.ts` 도구 목록 미러 테스트 동시 수정 |
| 0026 교체 RPC | `replace_synced_range(connection, range, rows)` security definer, search_path 고정 | EXECUTE authenticated만. 내부에서 세션 사용자 owner/admin·workspace·connection 일치 검증. `created_by = auth.uid()`(security definer는 RLS를 우회하므로 정책 대신 함수 안에서 owner/admin·`created_by = auth.uid()`를 검증, 임의 값을 받지 않음). `revenue_rows.row_key`는 RPC 안에서 `revenue.ts` `rowKey`와 같은 규칙으로 계산하고 일치 테스트를 둔다. 삭제는 해당 connection의 `*-api` 행만 |

- **service role 금지는 고정 규칙**이다. 세션 기반이므로 `auth.uid()`가 있어 0019 `cf_caller_is_client()`는 호출자를 client로 판정하고, **상한 검사(0017 행 상한·0019 권한 규칙)가 API 경로에도 그대로 적용된다**.
- **키 회전 절차(재암호화 순서)**: ① 새 키·`key_version+1`을 서버 환경에 추가(구 키 유지) ② 앱이 신·구 키 모두 복호화 가능하게 배포 ③ 모든 grant를 구 키로 복호화 → AAD(`grant_id·workspace_id·google_sub·key_version` 신버전)로 재암호화해 `key_version` 갱신 ④ 구 버전 행 0건 확인 후 구 키 제거. 어느 단계에서 실패해도 구 키로 읽을 수 있게 유지한다.
- 마이그레이션 번호·분할은 가안이며 `0022~`에서 조정한다. 적용된 파일은 수정하지 않는다(0017 코멘트 갱신은 새 마이그레이션의 `comment on`).
- 새 테이블은 RLS·정책 컬럼 인덱스·코멘트 한 줄. `supabase/tests/run.ps1`에 교차 워크스페이스·토큰 비노출·**anon 호출 불가·타 워크스페이스 불가** 시험을 추가한다.
- 다이어그램 요청은 §9 참고.

## 6. 화면
기존 수익/성과 화면에 **연결 패널**을 붙인다(새 최상위 화면 없음). 표 형식은 NOMAD `ux-patterns` 스킬의 화면 표 형식을 따른다.

| 화면 | 유형 | 구성 블록 | 상태 | 다음 화면 |
|---|---|---|---|---|
| 연결 관리(설정·연동) | 목록+상세 | 출처 카드 3개(GSC·AdSense·GA4, 순서 고정), 연결 상태 배지, 연결/해제, 블로그 매핑, 마지막 성공 시각, GSC 전체 사이트 읽기 권한 안내 | 미연결 · 동의 대기 · 활성 · 재연결 필요 · 오류 · 로컬 모드(안내만) | 동기화 기록, OAuth 동의(외부) |
| 동기화 기록 | 표 | 실행 시각·범위·상태·행 수·오류 사유, "지금 동기화", "화면이 열려 있을 때만 갱신" 안내, 상한 사전 차단 안내 | 없음 · 실행 중 · 성공 · 부분 · 지연 · 실패 · 상한 차단 | 연결 관리 |
| 성과/수익 화면의 출처 표시 | 요약 카드+표 | 값 옆 출처 배지(API/CSV/수동), `예상` 라벨, 마지막 동기화 시각, 범위. CSV·API 겹침 시 나란히 표시+안내(합산 없음) | 값 있음 · N/A(미연결) · N/A(동기화 실패, 사유) · 지연 · CSV·API 겹침 | 연결 관리 |

- 3구간: 모바일 ~767은 출처 카드 1열·기록 표는 카드 목록, 태블릿 768~1199는 카드 2열, 데스크톱 1200~는 카드 3열+기록 표 병렬. 구간별 폰트는 기존 토큰.
- 키보드 접근·포커스 표시, 연결 해제는 확인 대화상자(연결만 끊김·마지막 연결이면 Google 권한 철회까지 함을 안내). 빈 상태와 저장 실패 처리 필수.
- 문구: 미연결 "연결되지 않음", 실패 "가져오지 못함", 값 0은 실제 0일 때만. "자동 수집 중" 문구는 쓰지 않는다(세션 기반) — "마지막 동기화 시각"만 표시.
- 실제 수익 데이터가 없으면 N/A(AGENTS.md 규칙).

## 7. 보안 위협 메모
| 항목 | 내용 |
|---|---|
| 노출 면 | OAuth 시작·콜백 엔드포인트(인터넷 접근), 동기화 트리거 엔드포인트, 연결 관리 화면, credential RPC |
| 인증·인가 | 연결·해제·동기화 owner·admin, 조회 멤버. 콜백은 state(쿠키 바인딩)·시작 사용자=세션 사용자·owner/admin 재확인. 같은 워크스페이스 블로그만 매핑. RPC는 security definer + 세션 `is_member` 확인, authenticated만 |
| 데이터 | refresh token(고민감), 외부 지표, 계정/속성 식별자, 수익 수치 |
| 키·권한 | Google client secret·토큰 암호화 키(서버 환경 변수, 버전 관리, AAD = grant_id·workspace_id·google_sub·key_version(grant를 여러 연결이 공유하므로 grant 단위)). **service role 키는 앱에 넣지 않는다(고정 규칙).** 세션 기반이라 `cf_caller_is_client()`=client, 상한 검사 적용. scope는 읽기 전용만 — 단 `webmasters.readonly`는 계정 전체 사이트 읽기(§3) |
| 신뢰 경계 | 같은 워크스페이스의 owner/admin은 서로 신뢰한다. admin은 재동의 RPC로 grant의 `created_by`를 자신으로 바꾸거나 `rotate_credential`로 암호문을 바꿀 수 있다(토큰 탈취는 불가, 최악은 연결 중단). 다른 Google 계정의 토큰은 grant 키(workspace·google_sub·client) 때문에 얻을 수 없다. 운영에서는 `APP_URL` 필수(콜백 origin 고정). 같은 Google 사용자가 여러 워크스페이스에 연결한 경우 한쪽 revoke가 다른 쪽 grant를 무효로 만들 수 있다(가용성, `needs_reauth`로 드러남) |
| 입력 | 콜백 `code`·`state`(1회용·만료), Google 응답(스키마 검증·크기 상한), 속성·계정 ID(앱 내부 허용 목록, Google 범위 제한 아님) |
| 체인 | ① state 검증 약함 → 다른 Google 계정이 내 블로그에 연결(CSRF). ② **공격자가 자기 계정 콜백을 피해자 세션에 주입 → 공격자 속성 수치가 내 장부에 섞임(수치 오염)** → 쿠키 바인딩·시작 사용자=세션 사용자·source `-api` 분리·화면 출처 배지로 방어. ③ 토큰 로그 노출 → 계정 전체 읽기. ④ 교체 RPC 권한 느슨 → 타 워크스페이스·CSV 행 삭제 ⑤ revoke 실패 방치 → 해제했다고 믿는 유효 토큰 잔존(보관·재시도·안내) |
| 피해 범위 | 토큰 유출 시 해당 Google 계정의 읽기 범위(검색·수익·분석). 쓰기 불가이나 수익 정보는 민감 |
| 남용 | "지금 동기화" 난발·폴링으로 쿼터 소진 → 쿨다운·연결당 동시 1건·워크스페이스 상한 |
| 로그 | 연결·해제·동기화 결과 O. 토큰·인가 코드·응답 본문·수익 원문 X |
| 결정 | 토큰은 브라우저에 절대 반환 안 함, AES-GCM 암호화 저장, 해제 시 grant 0개일 때 revoke, 교체는 단일 트랜잭션 RPC, 위험도 높음 → challenger+보안 리뷰 |

## 8. 결정 항목
| # | 항목 | 결정·권고 | 상태 |
|---|---|---|---|
| D0 | **실행 주체** | 세션 기반만: "지금 동기화" + 화면이 열려 있을 때 폴링. 무인 cron·새 비밀 주체는 비범위(후속, 별도 challenger) | **결정됨**(사용자) |
| D1 | 출처 순서 | **GSC → AdSense → GA4**, 작업 분해도 이 순서 | **결정됨**(사용자) |
| D2 | 토큰 저장·읽기 | 앱 서버 AES-GCM, 키는 서버 환경 변수, AAD = grant_id·workspace_id·google_sub·key_version(grant를 여러 연결이 공유하므로 grant 단위), DB엔 암호문만. security definer RPC + 세션 owner/admin 확인, authenticated만 EXECUTE, 권한 시험을 완료 조건에. service role 금지(고정). 키 회전은 §5 | **결정됨**(팀장) |
| D2a | credential 단위·해제 | grant 단위 공유, 연결 0개일 때만 revoke, 실패 시 보관·재시도·안내(§3) | **결정됨**(팀장) |
| D2b | API·CSV 행 분리 | source 값 분리(`*-api`), provenance 컬럼 없음, 화면 합산 없음(§2) | **결정됨**(팀장) |
| D2c | 재조회 교체·created_by | 연결별 겹치는 `*-api` 행 삭제 후 재삽입(단일 트랜잭션 RPC), created_by=세션 사용자, 강등·제거 시 `needs_reauth`(§3·§4) | **결정됨**(팀장) |
| D2d | OAuth state·PKCE | httpOnly 쿠키 + 시작 사용자=세션 사용자 + owner/admin 재확인(§3) | **결정됨**(팀장) |
| D3 | 주기·재조회 창·최초 과거 일수 | 연결당 수동·폴링 실행 최소 간격 **15분**(서버 강제), 화면 폴링은 마지막 성공 후 24시간 지났을 때만 자동 실행, 재조회 창 **3일**, 최초 과거 **90일**(GSC 보존 범위 안). 값은 서버 상수 한 곳 | **결정됨**(팀장, 2026-11-15) |
| D4 | 연결 해제 시 가져온 데이터 | 기본 **유지**(`*-api` source 보존, 화면에 "연결 해제됨" 표시). 해제 대화상자에 "가져온 데이터도 삭제" 선택(owner/admin, 해당 connection의 `*-api` 행만) | **결정됨**(팀장) |
| D5 | API·CSV 겹침 표시 | 둘 다 보존·나란히 표시·합산 없음. 문구: "같은 기간에 CSV와 API 데이터가 모두 있습니다. 두 값은 합치지 않고 출처별로 보여줍니다." | **결정됨**(팀장) |
| D6 | AdSense `PAGE_URL` 사용 | 조건부로 결정: 실제 계정에서 조합이 확인되면 글별, 아니면 사이트·일 수준만(글별 ROI N/A). 확인은 A6 착수 시 | **결정됨**(조건부) |
| D7 | OAuth 동의 화면 게시 상태·앱 검증 | 파일럿은 **Testing** 상태로 운영하고 7일마다 재연결을 감수한다(Testing·외부 사용자의 refresh token은 7일 만료 — [Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2), 2026-11-15 확인). `webmasters.readonly`는 민감 scope라 공개 출시 전 Production 전환·앱 검증 필요([앱 상태 개요](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)). 화면에 만료 예정 안내 | **결정됨**(팀장) |
| D8 | Google 클라이언트 발급 주체·프로젝트 | 사용자가 Google Cloud에서 발급(웹 애플리케이션, 리디렉션 `/{origin}/api/integrations/google/callback`). 앱은 `GOOGLE_OAUTH_CLIENT_ID/SECRET` 환경 변수, 미설정 시 연결 버튼 비활성·"연결 안 됨"(가짜 연결 표시 금지). 구현·시험은 가짜 Google 서버로 먼저 진행 | **결정됨**(실키 검증은 발급 후) |
| D9 | refresh token 개수 상한 대응 | Google 계정×클라이언트당 **100개**, 초과 시 가장 오래된 것이 조용히 무효([Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2), 2026-11-15 확인). (워크스페이스, Google sub)당 grant 1개 재사용으로 발급 수를 줄이고, `invalid_grant`는 `needs_reauth` | **결정됨**(팀장) |

## 9. 작업 분해
출처 순서 GSC → AdSense → GA4. 근거는 이 문서의 장.

| ID | 작업 | 담당 | 근거 | 위험 | 완료 조건 |
|---|---|---|---|---|---|
| A0 | 미결 D3~D9 확정, 다이어그램 | 팀장·diagrammer | §8 | 낮음 | 완료(2026-11-15) |
| A1 | 0022~0024 연결·grant·기록 테이블 + credential RPC + RLS | builder | §5, D2 | **높음**(RLS·키) | `supabase/tests/run.ps1`: 토큰 직접 조회 불가, **anon 호출 불가, 타 워크스페이스 불가**, 멤버(비 admin) 불가 |
| A2 | OAuth 시작·콜백·해제(GSC 먼저): 쿠키 state·PKCE, 사용자 일치, revoke 실패 보관·재시도 | builder | §3, §7 | **높음**(인증·토큰) | 단위+e2e(공격자 콜백 주입 거부 시험 포함), challenger+보안 리뷰 |
| A3 | 0025·0026 저장 계약 확장 + 교체 RPC, 0017 헤더 코멘트 갱신, **tool `ga4-api` 추가 시 0017 체크·`blog-metrics.ts` 미러 테스트** 동시 수정 | builder | §2, §4, §5 | **높음**(마이그레이션) | 재수입 중복 없음, CSV·수동 행 삭제 불가, 교차 워크스페이스 거부, 상한 검사 적용(client), 미러 테스트 통과 |
| A4 | **GSC 수집기**(page×일, 증분·재조회·쿼터·상한 사전 차단·실패 기록) + 세션 폴링 | builder | §2, §4 | 보통 | 실패≠0 시험, 상한 초과 사전 차단 시험 |
| A5 | 연결 관리·동기화 기록 화면, 성과 화면 출처 배지·CSV/API 나란히 표시 | builder+designer | §6 | 낮음 | 3구간·키보드·N/A 문구·합산 없음 시험 |
| A6 | **AdSense 수집기**(`estimated`만, PAGE_URL 조건부, 통화·시간대 필수) | builder | §2, D6 | **높음**(수익 데이터) | RPM 분모 시험, `*-api`/CSV `summarize` 분리 시험 |
| A7 | **GA4 수집기**(선택) | builder | §2 | 보통 | 별도 행, RPM 미사용 시험, A3 체크·미러 테스트 |
| A8 | README 진행 현황·`tasks/NOW.md` 갱신 | 팀장 | AGENTS.md | 낮음 | 상태가 실제 연결과 일치 |

다이어그램: [연결 시퀀스](../diagrams/analytics-sync-sequence.mmd) · [연결·실행 상태도](../diagrams/analytics-sync-states.mmd). 요청 원문(diagrammer): ① 시퀀스 — 사용자(세션)·앱 서버·Google OAuth·DB의 연결 흐름(쿠키 state·PKCE, 사용자 일치 확인, code 교환, AES-GCM 암호화 저장, 해제·revoke 실패 재시도) ② 상태도 — 연결 상태(`pending/active/needs_reauth/revoked/error`)와 동기화 실행 상태(`succeeded/partial/failed/delayed`) ③ ERD 갱신은 마이그레이션 후 `sql2erd`.
