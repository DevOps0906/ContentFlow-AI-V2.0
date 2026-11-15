# 초과 슬롯 실결제 연동 (기능 명세, 초안 r2 — B안: 세션 기반·소유자 수동 결제)

버전: **r2** (2026-11-16) · 상태: 초안(구현 보류) · 작업: CF-23(착수는 §10 사용자 결정·가맹점 계약·challenger r2 후) · 상위: [MULTI_BLOG_BILLING.md#3](MULTI_BLOG_BILLING.md), [#4](MULTI_BLOG_BILLING.md), [#13](MULTI_BLOG_BILLING.md), [MONETIZATION_STRATEGY.md#9](MONETIZATION_STRATEGY.md), [PRD.md#8](PRD.md)
현재 상태: **결제사가 연결되어 있지 않다.** 있는 것은 월 peak 계량(`blog_usage_snapshots`)과 초과 고지뿐이다([0019](../../supabase/migrations/0019_blog_entitlements.sql)). 연결 전에는 화면·문구가 "청구됨·결제됨"을 말하지 않는다(문구는 "결제 준비 중" 유지).
r1 → r2: challenger r1(REVISE) 지적을 반영하고 범위를 B안으로 좁혔다. 반영 위치는 §12. **D2는 B안 가정**이며 최종은 사용자 결정 대기(§10).

## 1. 목적·범위
- 목적: 워크스페이스 **소유자**가 결제수단(카드 빌링키)을 등록하고, 지난달 초과 슬롯 금액의 invoice를 **직접 눌러** 결제한다. 서버는 invoice를 SQL로 확정하고 결제사 응답을 재조회해 결과를 기록한다.
- 계산 규칙은 [MULTI_BLOG_BILLING.md#4](MULTI_BLOG_BILLING.md)·[#13](MULTI_BLOG_BILLING.md)(월 단위 peak, 일할 없음). 금액은 **설정값**이며 가격 상수를 코드·문서에 넣지 않는다(§5 `billing_prices`).
- 실행 주체는 세션뿐이다(소유자가 화면을 열거나 버튼을 누를 때). 무인 작업·새 비밀 주체는 없다([ANALYTICS_SYNC.md#8 D0](ANALYTICS_SYNC.md) 선례).

| 비범위(후속, 별도 challenger) | 이유 |
|---|---|
| 자동 청구·재시도 스케줄·유예 일수·미납 자동 제한 | 무인 실행 = 새 비밀 주체 필요(§10 D2) |
| 결제사 웹훅 수신 | 공개·무세션 엔드포인트가 필요해 "클라이언트 접근 차단"과 충돌. 승인 응답+재조회로 충분 |
| 플랜 변경·구독 해지·플랜 하향 처리 | 초과 슬롯만 청구. `enforce_plan_lock`·`cf_caller_is_client()` 변경 불필요(§5) |
| 세금계산서·현금영수증, 해외 결제, 쿠폰·연 결제, 기본료 청구 | 요건 `미확인`(D3·D5). invoice는 줄 단위(`invoice_lines`)로 확장 가능 |
| 카드번호·CVC 수집·저장, 다중 수단, 로컬 모드 | 결제사 결제창/빌링키만(고정), 카드 1개, 계정 모드만 |

## 2. 결제사 비교·권고
권고: **토스페이먼츠 빌링(카드 저장 결제)**. 근거는 국내 사업자 대상 KRW 카드 청구와 직계약의 단순함이다. 표의 수치·정책은 공식 문서·계약서로 확인되기 전까지 `미확인`이다.

| 항목 | 토스페이먼츠(권고) | 포트원 경유 | Stripe |
|---|---|---|---|
| 구조 | 결제사 직접 연동 | 중개 계층, PG 계약 별도 가능성 `미확인` | 글로벌 직접 |
| 정기결제 방식 | 빌링키 발급 후 서버 승인 호출(세부는 공식 문서) | PG에 따름 `미확인` | SetupIntent(카드 저장) |
| KRW·국내 카드 | 국내 카드 지원 | PG에 따름 | 한국 사업자 가입·국내 카드 범위 `미확인` |
| 수수료·한도·정산 | `미확인`(계약 협의) | `미확인` | `미확인` |
| 가맹점 심사·빌링 계약 | 별도 승인 필요 여부 `미확인` | `미확인` | `미확인` |
| 주문 조회(재조회)·멱등 키 | 조회 API·멱등 키 지원 여부 `미확인`. 자체 `order_id` UNIQUE로 보완 | `미확인` | 지원(문서 확인 필요) |
| 결제사 측 금액 상한·IP 허용 목록 | `미확인`(§9 피해 범위) | `미확인` | `미확인` |
| 공식 문서 | [docs.tosspayments.com](https://docs.tosspayments.com/) | [developers.portone.io](https://developers.portone.io/) | [docs.stripe.com](https://docs.stripe.com/) |

- 결제사 추상화는 만들지 않는다. 서버 모듈 경계만 `payments/` 한 곳으로 모은다.
- 결제사 선택·계약은 사용자 항목(§10 D1). 계약 전 구현·시험은 **가짜 결제사 서버**로 하고 실제 연동 문구는 열지 않는다([ANALYTICS_SYNC.md#8 D8](ANALYTICS_SYNC.md) 선례).

## 3. 과금 흐름
후불(지난달 분을 다음 달 이후 소유자가 결제). 한 달의 금액은 **invoice 확정 시 1회 계산하고 이후 불변**이다.

| 단계 | 규칙 | 주체 |
|---|---|---|
| 1 결제수단 등록 | 소유자가 결제창에서 카드 인증 → 서버가 `authKey`로 빌링키 발급 → 암호화 저장 + 표시 정보(브랜드·끝 4자리)만 저장 | 소유자 세션 |
| 2 invoice 확정 | 소유자가 청구 화면을 열거나 "결제"를 누를 때 `finalize_invoices(workspace)` SQL이 **지난달 이전 월**만 확정(§3-A). 같은 (workspace, period) 1건 UNIQUE, 확정 후 값 불변 | DB 함수 |
| 3 금액 | 확정 시 `overage_slots × unit_price_krw`(정수 원, 총액)를 DB가 계산해 복사 저장. 클라이언트 금액 입력 없음. 0원이면 `no_charge`로 종료, 결제 호출 없음 | DB 함수 |
| 4 결제 | **소유자의 POST로만** 시작. 화면 열기·링크 prefetch·다중 탭은 결제를 일으키지 않는다. 서버가 `begin_payment_attempt`로 `requested`를 **선기록**한 뒤 빌링키로 승인 호출(금액=invoice 금액, `order_id`=서버 발급) | 소유자 세션+서버 |
| 5 확정 | 승인 응답을 받으면 결제사 조회 API로 재조회해 상태·금액·`order_id`를 대조(§4). 성공 → `paid`, 영수증 링크 저장 | 서버 |
| 6 실패 | 실패 사유 코드를 보여 주고 소유자가 다시 누르면 새 시도. 자동 재시도 없음 | 소유자 |

- 미납은 **표시만** 한다(청구 내역 `미납` 배지). 서비스 제한·보관 요구 발동은 r2에 없다(§10 D4). 수금은 소유자가 누르는 데 달려 있다는 사업 리스크가 있다.
- 시간 경계: KST 달력 월([MULTI_BLOG_BILLING.md#13](MULTI_BLOG_BILLING.md)). 이번 달 이후는 확정하지 않는다.

### 3-A. invoice 확정 규칙 (SQL 함수, 이월 계산)
0019 snapshot은 blogs 변경 이벤트가 있는 달에만 생긴다. 이벤트 없는 달은 아래 규칙으로 **확정 시 1회** 계산하며 이후 재계산하지 않는다(원본 snapshot은 수정하지 않는다).

| 지난달 상황 | 그 달 peak (이월) |
|---|---|
| snapshot 있음 | `peak_active` 그대로 |
| 없음, 이전 달 snapshot 있음 | 가장 가까운 이전 snapshot의 `active_at_close` |
| 없음, 이전·이후 snapshot 모두 없음 | 현재 `blogs` 활성 수(이벤트 없음 = 변화 없음) |
| 없음, 이전 없고 이후만 있음(계량 시작 전 달) | 청구 안 함(`no_charge`) |

- 초과 슬롯 = max(0, peak − 포함 수). 포함 수는 확정 시 `workspace_entitlements.included_blogs`를 복사한다(snapshot의 `overage_slots`는 이벤트 시점 포함 수라 쓰지 않는다).
- **월중 플랜 변경이 있었던 달**(운영자 SQL로 `workspace_entitlements.updated_at ≥ period_start`)은 확정을 보류하고 운영자가 처리한다(플랜 변경 흐름은 비범위라 재계량을 만들지 않는다). 감지 방식의 정확성은 P1 검토 대상.
- 가격은 청구 대상 월 `period_start`에 유효한(`effective_from ≤ period_start`) 최신 `billing_prices` 행.
- **청구 제외(DB 조건)**: ① 해당 월 말 시점 유예 유효(`grace_until ≥ period_end`) ② 해당 워크스페이스에 `blog.overage_ack` audit 기록이 없음(동의 없는 청구 금지). 동의 판정이 월·블로그 단위로 충분한지는 P1에서 검토(`팀장 결정 필요` 아님, 설계 검증 항목).
- 결제수단 없이 초과 활성화를 허용할지는 §10 D13(사용자 결정). 허용 시 초과분은 invoice로만 쌓이고 결제는 소유자가 수단 등록 후 누른다.

## 4. 결제 결과 확정·금액 위변조 방지 (웹훅 없음)
| 항목 | 규칙 |
|---|---|
| 신뢰 원칙 | 승인 응답 본문을 그대로 믿지 않는다. 서버가 결제사 API를 비밀 키로 **재조회**한 결과(상태·금액·order_id)만 반영 |
| 금액 | 승인 금액 = invoice 총액(`amount_krw`, VAT 포함 여부는 D5). 재조회 `amount`와 정수 일치할 때만 `paid`. 불일치 → 기록 `failed(amount_mismatch)`·운영 확인. 승인 호출 금액은 항상 DB invoice에서 읽음 |
| 진행 중 1건 | `payment_attempts`에 **invoice당 부분 unique**(`status in ('requested','unknown')`). 동시 클릭·다중 탭은 DB가 거부 → 이중 승인 불가 |
| 복구(requested 이후 종료·타임아웃) | `requested`·`unknown`이면 **승인 재호출 금지**. 소유자가 "결과 확인"을 누르면 서버가 `order_id`로 결제사 조회: 완료 → `paid`, 실패 → `failed`, 조회 결과 없음 → 일정 시간(`미확인`, 결제사 조회 보존 기간 확인 후 확정) 지난 뒤에만 `failed(not_found)`로 닫고 새 시도 허용 |
| 매칭 | `order_id`는 서버 발급·UNIQUE. 다른 워크스페이스 invoice로 교차 반영 금지 |
| 상태 역행 | 전이표(`requested→paid|failed|unknown`, `unknown→paid|failed`, `paid→refunded`)만. 최종 강제는 DB 트리거 |
| 빌링키 발급 콜백 | 복귀 `authKey`·`customerKey`를 세션 사용자(owner)·쿠키 state(1회용·만료)와 대조해야만 발급. `customerKey`는 서버 발급 랜덤 값(워크스페이스 id 직접 사용 금지) |
| 결과 기록 위조 | §9 체인 ①: DB는 결제사 응답을 검증할 수 없다. 소유자 JWT로 결과 RPC를 직접 호출하면 `paid` 위조 가능 → §10 D14 |

## 5. 데이터 모델 변경안
마이그레이션 **0028~0030**(0027까지 사용 중). 안이며 SQL은 builder가 쓴다. 공통: 금액 `bigint`(정수 원, `check >= 0`), RLS 활성 + 정책 + 정책 컬럼 인덱스 + 코멘트, authenticated·anon 테이블 쓰기 권한 없음(`revoke`), 비밀·원문 응답 저장 금지.

| 번호(안) | 테이블 | 핵심 컬럼 | RLS·원칙 |
|---|---|---|---|
| 0028 | `billing_prices` | `unit_price_krw`, `vat_mode`(D5), `effective_from`, `created_by` | 멤버 읽기 X. 운영자 SQL INSERT만(UPDATE 금지), 이력 보존 |
| 0028 | `billing_customers` | `workspace_id`(PK), `provider`, `customer_key`, `billing_key_ct`·`key_version`, `card_brand`, `card_last4`, `status`(active·removed) | 소유자 select(암호문 제외 view). 쓰기는 security definer RPC만 |
| 0029 | `invoices` | `id`, `workspace_id`, `period_start`, `peak_active`, `included_blogs`, `overage_slots`, `unit_price_krw`, `amount_krw`(총액), `vat_krw`(표시용), `status`(no_charge·pending·paid·void·refunded), `paid_at`, `receipt_url` | UNIQUE(workspace_id, period_start). 소유자 select. 입력값 복사 후 **불변 트리거**(status·paid_at·receipt_url만 전이) |
| 0029 | `invoice_lines` | `invoice_id`, `kind`, `quantity`, `unit_price_krw`, `amount_krw` | 합계 = 줄 합 검사 |
| 0030 | `payment_attempts` | `id`, `invoice_id`, `attempt_no`, `order_id` UNIQUE, `provider_payment_key`, `amount_krw`, `status`(requested·unknown·paid·failed), `failure_code`, `requested_at` | **부분 unique(invoice_id) where status in ('requested','unknown')**. 소유자 select(실패 코드만) |
| 0030 | `audit_logs` 액션 | `billing.method_registered`·`billing.method_removed`·`billing.invoice_finalized`·`billing.invoice_paid`·`billing.refund` | `billing.%`는 definer RPC만 기록([0019 정책](../../supabase/migrations/0019_blog_entitlements.sql) 방식) |

- 쓰기 경로: security definer RPC(`finalize_invoices`·`begin_payment_attempt`·`record_payment_result`·키 저장·삭제)가 **세션의 `auth.uid()`가 owner인지** 확인한다. EXECUTE는 authenticated에만, 시험에 권한 검증을 넣는다([ANALYTICS_SYNC.md#8 D2](ANALYTICS_SYNC.md) 방식). service role·새 DB 역할·`set_config('role', ...)`·`SET ROLE` 금지.
- **`workspaces.plan`은 바꾸지 않는다.** 따라서 `enforce_plan_lock`·`cf_caller_is_client()`·블로그 상한 검사(`enforce_blog_limits`)는 **변경하지 않는다**(r1 🔴 해소, 면제 범위 확대 없음). 플랜 변경 컬럼(`pending_plan` 등)은 만들지 않는다.
- 빌링키 암호화: AES-GCM, 키는 서버 환경 변수·버전 관리, AAD = workspace_id·provider·key_version([ANALYTICS_SYNC.md#8 D2](ANALYTICS_SYNC.md) 재사용).
- 변경 후 `sql2erd`로 `docs/diagrams/erd.mmd` 갱신, `supabase/tests/run.ps1`에 권한·UNIQUE·전이 시험 추가.

## 6. 화면
소유자만 결제수단·청구·결제를 본다. 관리자·편집자는 "결제는 소유자만 관리합니다" 안내와 사용량 배지만 본다. 설정 > 결제(신규). 표 형식은 ux-patterns 2절.

| 화면/요소 | 유형 | 구성 블록 | 상태 | 다음 |
|---|---|---|---|---|
| 결제 개요 | 설정 페이지 | 이번 달 사용량("peak n / 포함 m, 초과 k"), 예상 금액("금액 미정" 또는 설정값 기준), 결제수단 카드, 미결제 청구 안내, 최근 청구 3건 | 빈(수단 없음)·로딩·저장 실패·권한 없음·`미연동` 배지 | 결제수단 등록, 청구 내역 |
| 결제수단 등록 | 외부 결제창 이동 + 복귀 | 안내(카드 정보는 결제사가 처리, 우리는 저장 안 함), "카드를 저장하고 내가 결제할 때 사용" 동의 체크, "카드 등록" | 동의 전 비활성·발급 중·성공·결제창 취소·인증 실패(코드별 문구) | 결제 개요 |
| 결제수단 변경·삭제 | alert dialog([OVERLAY_UX.md](../07-design/OVERLAY_UX.md)) | 현재 카드(브랜드·끝 4자리), 미결제 청구 있음 경고 | 확인 체크 전 비활성 | 결제 개요 |
| 청구 내역 | 목록(표/카드) | 월·peak·초과 슬롯·금액·상태 배지·영수증 링크 | 빈·로딩·실패·`미결제`·`환불됨`·`청구 없음` | 청구 상세 |
| 청구 상세 | 상세 패널 | 계산 근거(확정 때 복사된 peak·포함 수·단가·합계), 결제 시도 목록(시각·결과·실패 사유), "결제하기"(소유자 클릭 POST) | 결제 중(중복 클릭 비활성)·`결과 확인 중`(requested·unknown, "결과 확인" 버튼) | 청구 내역 |

- 3구간: 모바일(~767) 카드형·대화상자 전체 폭 하단, 태블릿(768~1199)·데스크톱(1200~) 표형·중앙 대화상자. 폰트 크기는 디자인 토큰.
- 키보드: 포커스 트랩, Esc 취소, 동의 체크박스·결제 버튼 Tab 도달, 상태는 색+텍스트.
- 문구 금지: "자동결제"·연동 전 "청구됨·결제됨"·확정 금액. 로컬 모드에는 결제 메뉴 없음. 금액이 없으면 "금액 미정".

## 7. 다운그레이드 보관 요구 (`BLOG_OVER_ENTITLEMENT`) — r2 비범위(규칙만 보존)
[MULTI_BLOG_BILLING.md#5](MULTI_BLOG_BILLING.md)·[#6](MULTI_BLOG_BILLING.md)에서 이관된 항목. 플랜 변경·미납 제한이 비범위라 r2에서는 구현하지 않고 후속 규칙으로 남긴다.

| 항목 | 규칙(후속) |
|---|---|
| 발동 | `활성 수 > 허용 수`(허용 = `overage_allowed ? max_blogs : included_blogs`). 원인은 플랜 하향·해지·미납 제한(후속) |
| 데이터 | **삭제하지 않는다**. 기존 글·키워드 열람·수정 가능([MULTI_BLOG_BILLING.md#10](MULTI_BLOG_BILLING.md)) |
| 차단 | 보관 선택 전 새 글·키워드 연결과 `archived → active` 복원 차단, `BLOG_OVER_ENTITLEMENT`(409). 최종 강제는 DB 트리거(`enforce_blog_limits` 변경이므로 후속 challenger) |
| 선택 | 소유자·관리자가 선택. 자동 보관 없음(D7) |

화면(보관 요구 배너·보관 선택 목록)은 후속 설계에서 §6 표 형식으로 추가한다.

## 8. 환불·취소·분쟁 최소 규칙
법률 요건(청약철회·환불 기한·고지)은 `미확인`이며 §10 D8 법무 확인 전에는 **운영 규칙 초안**이다.

| 상황 | 규칙 |
|---|---|
| 이중 결제·금액 불일치 | 서버 감지 시 초과분 전액 취소 API 호출 + `billing.refund` audit. 이중 승인은 §4 부분 unique로 원천 차단 |
| 사용자 환불 요청 | 자동 환불 없음. 운영자가 invoice 단위 취소(결제사 콘솔/API) → `refunded`. 전액만 |
| 분쟁(카드사 이의) | 운영자 수동 처리, 소유자 화면에 별도 상태 없음(r2는 상태 5종 유지, 필요 시 후속) |
| 청구 내용 이의 | 복사된 계산 근거·`blog_usage_snapshots`·audit로 소명. 오류 확인 시 `void` 후 운영자가 재확정 |
| 결제수단 삭제 | 결제사에서 빌링키 삭제 후 우리 암호문 제거. 실패 시 재시도 안내 |

## 9. 보안 위협 메모
| 항목 | 내용 |
|---|---|
| 노출 면 | 결제수단 등록 시작·복귀 엔드포인트, 소유자 결제 POST, "결과 확인" POST, invoice 확정 RPC. **웹훅·무인 작업 진입점 없음** |
| 인증·인가 | 모든 경로 세션 + 서버·RPC의 owner 재확인. 관리자·편집자 접근 불가. 조회는 소유자만 |
| 데이터 | 빌링키(고민감), 카드 표시 정보, 청구 금액·결제 이력, 영수증 URL. **카드번호·CVC는 서버·DB·로그에 없음** |
| 키·권한 | 결제사 시크릿 키·빌링키 암호화 키는 서버 환경 변수(키 이름은 구현 때 확정, 서로 별도 변수·버전 관리). **service role 키·새 DB 역할·새 비밀 주체 없음.** 결제 클라이언트 키(공개용)만 브라우저. 브라우저↔Supabase 직접 통신 없음 |
| 신뢰 경계 | 같은 워크스페이스 관리자도 결제수단·청구 접근 불가. 소유자 이전 시 빌링키 재등록(D10) |
| 입력 | 복귀 쿼리 `authKey`·`customerKey`·`state`(1회용·만료), 결제사 응답(스키마 검증·크기 상한) |
| 체인 | ① **결과 기록 위조**: 소유자가 자기 JWT로 `record_payment_result`를 직접 호출해 결제 없이 `paid` 기록 → 데이터 해킹이 아니라 **청구 우회**. 후보 대응은 D14. ② 금액 변조 → DB가 invoice에서 읽음, 입력 금액 없음. ③ 빌링키 탈취 후 임의 청구 → 아래 피해 범위. ④ 복귀 콜백 CSRF(공격자 카드 연결) → 쿠키 state·세션 일치. ⑤ 타임아웃 재호출 이중 청구 → §4 부분 unique·재호출 금지. ⑥ 화면 열기·prefetch로 결제 → 결제는 POST만, GET은 읽기만. ⑦ RPC EXECUTE 과다 → 최소 부여·권한 시험 |
| 피해 범위(env 유출) | AES 키와 결제사 시크릿이 같은 서버 환경에 있으면, env와 DB 읽기를 함께 얻은 공격자는 모든 빌링키를 복호화해 **임의 금액 승인**을 시도할 수 있다. 완화: 키 별도 변수·버전 회전, 승인 금액은 invoice에서만 읽는 **서버 코드**(env 유출 시엔 무력). 결제사 측 **금액 상한·IP 허용 목록 지원 여부는 `미확인`**(D1에서 확인·적용 요청) |
| 남용 | 카드 등록·결제 클릭 난발 → 쿨다운·시도 상한(값 `미확인`, 구현 때 확정). 결제사 차단 위험 |
| 로그 | 시도·결과 코드·invoice id O. 빌링키·authKey·카드 정보·응답 원문·비밀 키 X |
| 결정 | 위험도 **높음**(결제·RLS·마이그레이션·외부 계약·키·노출 면) → challenger 선행 + codex-reviewer(code) + reviewer(security/contract) → tester. PRD 보안 레벨은 `PRD.md#8` 갱신 필요(레벨 값 `팀장 결정 필요`) |

## 10. 사용자 결정 필요 항목
착수 전 사용자 결정 7건(challenger 요청 ①~⑦)은 아래 **굵은 행**이다. 번호는 r1과 같게 유지했다.

| # | 항목 | 권고(가설) | 상태 |
|---|---|---|---|
| D1 | **사업자 등록·가맹점·빌링 계약, 결제사 선택**, 약관상 빌링키 보관 책임, 결제사 측 IP 허용 목록·금액 상한 가능 여부 | 토스페이먼츠 빌링. 승인·심사 기간·수수료·정산 `미확인` → 계약 전 확인 | **사용자 결정 필요**(외부 절차) |
| D2 | **실행 주체** | **B안 가정**: 세션 기반만(소유자 열기·클릭 시 invoice 확정·결제, 웹훅·무인 작업 없음). A(전용 DB 역할)는 JWT 서명 비밀 또는 DB 접속 비밀이 필요해 service role 금지를 실질적으로 우회 → 후속·별도 challenger. [ANALYTICS_SYNC.md#8 D0](ANALYTICS_SYNC.md)과 일관 | **사용자 결정 대기**(B안 가정으로 작성) |
| D3 | **확정 가격·기본료 청구 여부** | 초과 슬롯 단가는 설정값. 파일럿 후 확정([MULTI_BLOG_BILLING.md#3](MULTI_BLOG_BILLING.md)). 가격 없이는 실결제 불가 | **사용자 결정 필요** |
| D5 | **부가세 처리**(포함/별도), 영수증·세금계산서 | 사업자 과세 유형에 따라 다름 `미확인`. 승인 금액 = 총액, `vat_krw`는 표시용 분리 | **사용자 결정 필요**(세무 확인) |
| D8 | **약관·개인정보 처리방침·전자상거래 고지**(동의 문구·환불 규정·사업자 정보) | 법무 확인 `미확인`. 문구 버전 `v1`부터 앱 상수·SQL 동일 관리([MULTI_BLOG_BILLING.md#13](MULTI_BLOG_BILLING.md) 방식) | **사용자 결정 필요** |
| D11 | **유예·무동의 워크스페이스 비청구 확인**(§3-A 제외 조건 ①②) | 비청구(DB 제외). 동의 판정 방식은 P1 검토 | **사용자 결정 필요**(확인) |
| D12 | **테스트 키 제공·실키 사용 승인** | 구현·시험은 가짜 결제사. 실키 소액 결제는 승인 후만 | **사용자 결정 필요** |
| D13 | 결제수단 **미등록 상태의 초과 활성화** 허용 여부(결제수단 선등록 요구) | 선등록 요구가 안전하나 `enforce_blog_limits` 변경(후속 challenger). r2 기본은 허용·invoice 누적(수금 위험 명시) | **사용자 결정 필요**(r1 지적 🟡) |
| D4 | 미납 처리 | r2는 표시만, 제한 없음(권고). 재시도 횟수·유예는 자동 청구 도입 시 후속 | 팀장 결정 필요 |
| D6 | 하향·해지 적용 시점·예고 기간(후속) | 다음 달 1일 00:00 KST, 7일 전 예고 | 후속(비범위) |
| D7 | 보관 미선택 장기화(후속) | 자동 보관 안 함, 차단 유지 | 후속(비범위) |
| D9 | 마감 후 지연 변경 | **해소**: 확정 시 1회 계산·불변(§3-A). 지연 변경은 이후 월 | 반영됨 |
| D10 | 소유자 이전·탈퇴 시 빌링키·미납 | 이전 시 빌링키 삭제·재등록. 미납 있으면 이전 차단 | 팀장 결정 필요 |
| D14 | **결과 기록 위조 대응**(§4·§9 ①): (a) 서버가 결과에 HMAC 증명을 붙이고 DB가 검증(검증 비밀을 DB에 둠 — 새 비밀 위치) (b) 결과를 위조 가능한 채로 두고 결제사 정산 대조로 사후 검증 | **팀장 권고: (a)+(b).** 결과 기록 RPC는 서버가 결제사 응답(paymentKey·orderId·승인 총액·승인 시각)에 HMAC을 붙여야만 paid를 받는다. 검증 비밀은 클라이언트 권한이 전혀 없는 DB 전용 테이블(또는 Vault)에 두고 서버 env의 같은 값과 대조 — 소유자 JWT로 직접 호출해도 비밀 없이는 paid를 쓸 수 없다. 월 1회 결제사 정산 내역 대조(수동)로 사후 확인. 비밀 회전 절차는 P1에서 정의 | P1 challenger에서 확정 |

## 11. 작업 분해
근거는 이 문서의 장. CF-23 착수는 D1·D2·D3·D5·D8·D11~D13 확정과 challenger r2 후 사용자 승인으로만 한다([MULTI_BLOG_BILLING.md#10](MULTI_BLOG_BILLING.md)).

| ID | 작업 | 담당 | 근거 | 위험 | 완료 조건 |
|---|---|---|---|---|---|
| P0 | 사용자 결정 §10 확정, 결제사 비교표 `미확인` 해소, 다이어그램(과금 시퀀스·invoice 확정·시도 상태도) | 팀장·사용자·diagrammer | §2·§10 | 낮음 | 결정 기록 |
| P1 | r2 계획 공격(결과 위조 D14·이월 규칙·무동의 판정·env 피해 범위) | challenger | §3-A·§4·§9 | — | 🔴 0 |
| P2 | 0028~0030 테이블·RLS·부분 unique·불변·전이 트리거·audit | builder | §5 | **높음**(RLS·마이그레이션) | `supabase/tests/run.ps1`: 타 워크스페이스·비소유자·anon 접근 불가, 합계 검사, 상태 역행·동시 시도 거부, 암호문 직접 조회 불가 |
| P3 | `finalize_invoices` SQL(이월·제외·보류) | builder | §3-A | **높음**(결제 금액) | 이벤트 없는 달·플랜 변경 달·유예·무동의·KST 경계·재호출 멱등 시험 |
| P4 | 결제수단 등록 서버(복귀·빌링키 발급·암호화·삭제) + 가짜 결제사 서버 | builder | §3-1, §4, §9 | **높음**(키) | CSRF 복귀 거부, 키·카드 정보 로그 없음 |
| P5 | 소유자 결제 POST·시도 선기록·재조회·복구("결과 확인") | builder | §3-4~5, §4 | **높음**(결제) | 이중 승인 0건(동시 클릭·타임아웃·requested 직후 종료 시험), GET 무결제, 금액 불일치 거부 |
| P6 | 결제 개요·등록·청구 내역·상세 화면 | builder+designer | §6 | 보통 | 3구간·키보드·소유자만·문구 금지 시험 |
| P7 | 환불·분쟁 운영 절차(운영자 수동) | planner·팀장 | §8 | 낮음 | 절차 문서 |
| P8 | 통합 검증·보안 리뷰, README·`tasks/NOW.md`·PRD#8 갱신 | codex-reviewer+reviewer+tester | §9 | **높음** | 시험 통과, 🔴 0 |
| P9 | (조건부) 실키 소액 결제 검증 | 사용자 승인 | §2·D12 | **높음**(실결제) | 승인 후만, 환불 경로 확인 |
| 후속 | 자동 청구·재시도·웹훅·플랜 변경·보관 요구(§7)·미납 제한 | — | §1·§7 | 높음 | 별도 challenger 후 별도 명세 |

## 12. challenger r1 지적 → r2 반영 위치
판정 r1: REVISE(2026-11-16). 아래 모두 반영했으나 구현은 보류다(§10 사용자 결정·P1 대기).

| 등급 | r1 지적 | r2 반영 위치 |
|---|---|---|
| 🔴 | 이벤트 없는 달 근거 없음·플랜 변경 시 낡음 | §3-A 이월 표·"확정 시 1회 불변"·월중 플랜 변경 달 확정 보류(재계량은 비범위) |
| 🔴 | `enforce_plan_lock`이 새 역할을 client로 판정, 면제 시 상한 검사도 면제 | §1 비범위·§5: plan 변경 제외 → 판정 함수·트리거 **변경 없음** |
| 🔴 | A안은 JWT 서명 비밀·DB 접속 비밀 필요(service role 우회) | §10 D2: B안 가정, A는 후속. §9: 새 비밀 주체 없음 |
| 🔴 | B안 웹훅 큐 기록이 anon EXECUTE 필요(모순) | §1·§4: 웹훅 비범위. 새 모순(결과 위조)은 §4·§9 ①·D14로 정직하게 표기 |
| 🟡 | 진행 중 시도 1건 제약·requested 이후 복구 없음 | §4 부분 unique·복구 규칙, §5 `payment_attempts`, P5 시험 |
| 🟡 | VAT 분리 시 승인 금액 비교·`effective_from` 기준일 | §4 승인 금액 = 총액, §3-A `period_start` 기준 가격, D5 |
| 🟡 | 유예·무동의 청구·결제수단 선등록 | §3-A 제외 조건, §10 D11·D13 |
| 🟡 | AES 키·결제사 시크릿 같은 env 유출 | §9 피해 범위(정직 기술), 금액 상한·IP 허용 목록 `미확인`(D1) |
| 🟡 | 화면 열기가 청구 유발·"자동결제" 문구 | §3-4 결제는 소유자 POST만, §6 문구 금지, §9 체인 ⑥ |
| 🟡 | 과잉 설계(웹훅·상태 8종·플랜 변경) | §1 비범위, §5 invoice 상태 5종·시도 4종, 플랜 컬럼 제거 |
