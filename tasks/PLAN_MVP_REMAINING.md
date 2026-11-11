# MVP 잔여 작업 계획 (2026-11-11, challenger 검토 반영)

근거: `docs/01-planning/PRD.md#4,#10,#11`, `docs/03-database/DATABASE_SCHEMA.md`, `docs/06-workflows/WORKFLOWS.md#12`, `docs/04-content/CONTENT_TEMPLATES.md`.
불변 규칙: `AGENTS.md` (브라우저↔Supabase 직접 통신 금지, service role 금지, 수정 시 승인 해제, 미연결 API 표시 금지, 실제 데이터 없으면 N/A). 새 의존성 없음.

## 사용자 결정 (2026-11-11)

1. 멤버 권한으로 쓰는 AI·발행 로그의 위조 가능성을 수용한다. 운영 참고값으로만 표시하고 과금·정산 근거로 쓰지 않는다.
2. 렌더러 출력이 실제로 바뀔 때만 버전을 올리고, 버전이 다른 승인 글은 전달을 막아 재승인을 요구한다.
3. 티스토리 패키지는 이미지를 제외한다. `WORKFLOWS.md#WF-06` 범위 축소로 기록한다.
4. P0-13의 시간대·기간 보존과 부분 중첩 거절을 이번 범위에 넣는다.

## 저장 모드 범위

| 묶음 | 계정 모드 | 로컬 모드 |
|---|---|---|
| W1 | DB 기록 | 응답에 표시만, 저장 안 함 |
| W2, W5, W6(원가·개선 큐) | DB 기록 | 미제공. "계정 모드에서 사용 가능" 빈 상태 |
| W3, W4, W7 | DB 트리거 강제 | 공용 `lib` 규칙으로 앱에서 검사 |
| W6(수익 CSV 보강) | DB | 공용 파서로 브라우저 저장 |

## 구현 묶음 (같은 파일을 공유하므로 순차, 번호 고정)

### W1 AI 실행 기록 — P0-05, 0007 `agent_runs`
- 모델·프롬프트 버전·입출력 토큰·상태·소요 시간·비용 추정을 호출 종료 시 1회 INSERT한다(UPDATE 없음). 실패·타임아웃 분기도 기록한다.
- INSERT 정책: owner/admin/editor/reviewer. 조회: 워크스페이스 멤버.
- usage가 없으면 토큰·비용은 NULL(N/A, 0 금지). 비용은 환경변수 단가·통화로 실행 시점에 계산해 행에 저장한다.
- 로그 저장 실패는 AI 응답을 실패시키지 않고 서버 경고만 남긴다.

### W2 발행 시도·상태 이력 — P0-09, 0008 `article_state_events`, `delivery_attempts`
- `article_state_events`: DB 트리거(SECURITY DEFINER)가 상태 전이를 기록하고 클라이언트 쓰기 정책은 없다. 멤버 전원 조회. 작업 시간은 첫 전이부터 승인까지로 계산한다.
- `delivery_attempts`: 채널·시도 횟수·실패 유형·URL·소요 시간.
- WordPress: `sendDraft`가 실패 유형 있는 오류를 던진다. `cf-<글ID>` slug로 생성 전 선조회해 타임아웃·DB 저장 실패 뒤 재시도에도 원격 초안이 중복되지 않게 한다.
- 수동 전달은 `manual_pending` 전이 시 기록한다.

### W3 공개 URL·티스토리 패키지 — P0-08, 0009 `articles.published_url`
- `published`로 전이하는 UPDATE에서만 쓸 수 있고 http(s) 새 값을 요구한다. 그 외 상태에서 변경하면 거부한다.
- 수정으로 초안에 돌아가면 NULL로 초기화해 재게시에 새 확인을 요구한다. `remote.url` 자동 입력 금지(초안 링크일 수 있음). UNIQUE 없음.
- 승인 해제 대상(`changed`) 목록에 넣지 않고 reviewer 가드에 추가한다. 검사는 전이 시에만 하므로 기존 행과 monitoring·update_due의 NULL은 허용한다.
- 패키지: 정제 HTML·태그(키워드)·메타 JSON·안내문을 무의존 store ZIP으로 브라우저에서 생성한다. 다운로드 전 W4 전달 검사를 통과해야 하고, 다운로드 후 `manual_pending` 전이를 사용자가 확인한다.

### W4 표시·광고 프로필·승인 해시 — P0-12, PRD #11, 0010
- L01/L02/A00/A01과 `RENDERER_VERSION`은 코드 상수. `articles`에 `layout_profile`, `ad_profile`을 두고 변경 시 승인 해제. 렌더러 버전은 승인 시 서버가 넣으며 클라이언트 PUT에서 받지 않는다.
- 렌더링 원천을 구조화 블록 1개로 통일한다. 미리보기는 React 텍스트, export와 WordPress는 그 블록의 HTML escape 직렬화(기존 렌더러 2개 통합). A01 위치는 미리보기에만 표시하고 전달 HTML에는 넣지 않는다.
- `article_versions`에 `source_url, template_id, platform, layout_profile, ad_profile, renderer_version, hash_version`을 nullable로 추가하고 기존 행은 백필하지 않는다(거짓 기록 금지).
- 해시 v2: 위 필드와 제목·본문을 `jsonb_build_object`로 직렬화해 해시한다(NULL 경계 문제 제거). 공식 변경은 W4에서 1회만 한다.
- 전달 검사 `article_delivery_check` RPC: 승인 상태, `hash_version=2`, 저장 해시와 재계산 값 일치, 렌더러 버전 일치. WordPress 라우트와 HTML·티스토리 다운로드 앞단에서 호출한다. v1 승인 글은 재승인 대상이다. 로컬 모드는 렌더러 버전만 비교한다.
- 이전 묶음 복원은 후속.

### W5 사이트 준비 점검 — P0-11, 0011 `site_checks`
- 항목별 상태·근거·확인 시각·확인자. 광고 상태는 콘텐츠 상태와 분리하고 발행을 막지 않는다.

### W6 원가·개선 큐·수익 보강 — P0-13,14, 0012
- `cost_entries`: 수동 입력만 합계에 들어간다. `agent_runs` 추정치는 참고값으로 따로 표시하고 합산하지 않아 이중 계상을 원천 차단한다. 통화는 합산하지 않는다.
- `improvement_tasks`: 근거·URL·담당자·변경 버전·검토 기한. 자동 발행·효과 단정 없음.
- `revenue_rows`에 시간대·기간 추가. 동일 재가져오기는 건너뛰고 부분 중첩은 거절한다.

### W7 부분 구현 보완 — P0-02,03,04,06, 0013
- `articles.brief_purpose, brief_audience` 추가. 브리프 단계에서 나가는 전이에서만 목적·대상·근거 URL·채널을 강제하므로 기존 글 저장은 깨지지 않는다.
- `articles.evidence_status, rights_status`(unreviewed/ok/blocked): owner/admin/reviewer만 설정, 트리거가 승인 전이에서 둘 다 ok를 요구, 원고 수정 시 unreviewed로 초기화. AI 의견은 이 값을 바꾸지 않는다.
- 제목 평가 저장, T01/T02/T04 버전 고정.

완료 조건(묶음마다): `npm run typecheck`, `npm test`, 마이그레이션 변경 시 `supabase/tests/run.ps1`(Docker 필요), 교차 워크스페이스 차단 테스트. 독립 리뷰는 W1~2, W3~4, W5~7 묶어서 한다.

## 추가 범위: 블로그 계정별 트렌드·성과 분석 (2026-11-11 사용자 요청)

참고: Shopping-Shorts-Maker `docs/planning.md#10,#15-3`, `docs/design.md#5-4,#5-8` (기획·시안만 있고 구현 코드 없음). W7과 W5~7 리뷰 뒤 순차 진행한다.
공통: 외부 도구 값은 수동 입력·CSV로만 받고 출처·측정 시각을 함께 저장한다. 값이 없으면 N/A, 도구 간 값은 합산·환산하지 않는다. 화면의 외부 도구는 "바로가기"로만 표시하고 연결됨으로 표시하지 않는다. 스크래핑·비공식 API 금지. 계정 모드 전용(로컬 모드는 "계정 모드에서 사용 가능" 빈 상태).

### W5~7 리뷰 수정 — 0014
- DB: `drafting→qa_pending` 전이에도 브리프 필수값을 검사해 모든 글에 P0-02를 적용한다. 검수자 가드에 `keyword_id`를 추가한다. 개선 큐의 결과 버전이 미승인 스냅샷도 허용되는 점은 위조 수용 범주로 기록만 한다.
- 원가·개선 큐의 "오늘"을 로컬 날짜로 계산한다.
- 원가 저장 성공 뒤 재조회 실패를 저장 실패와 분리하고 입력을 비워 중복 저장을 막는다.
- 수익 분할 전송 실패 시에도 재조회하고 저장된 행 수를 표시한다.
- 원가 화면은 저장 정밀도로 표시해 소액이 0으로 보이지 않게 한다.
- 개선 큐에서 글을 바꾸면 자동 입력한 URL을 비운다.
- 수익 연결은 `publishedUrl`을 우선하고 `remote.url`은 대체로만 쓴다. 페이지 합계 키와 표에 출처를 추가한다.

### W9 블로그 계정 — 0015
- 기존 `blogs`를 설정 화면에서 추가·수정·보관한다(플랫폼: 네이버·티스토리·워드프레스·Blogger). 표시 이름 컬럼 추가.
- 글 작성 화면에서 블로그 계정을 고른다. `keywords.blog_id` nullable 추가. 수정 권한은 owner/admin.
- 기존 행은 "미분류"로 유지하고 백필하지 않는다. 트렌드·성과·수익 화면에 공용 블로그 필터(전체·계정별·미분류).

### W10 트렌드 분석 `/trends` — 0016 `keyword_trends`
- 상품 대신 블로그 키워드. 행: 블로그 계정·키워드·카테고리·월간 검색량·검색 증가율·문서 수(경쟁)·출처·측정일.
- 기회 점수 = 0.4×검색 증가 + 0.3×검색 수요 + 0.3×(100−문서 경쟁). 같은 블로그·카테고리 안에서 0~100 정규화. 가중치는 가설임을 화면에 표시하고, 입력이 하나라도 없으면 점수 N/A.
- 필터(블로그·카테고리·기간), 인사이트 카드 3개, 순위표, 카테고리별 점수 막대. "글 만들기"는 기존 키워드→아이디어 글 흐름을 재사용. 3구간에서 표는 모바일 카드로.

### W11 성과 분석 도구별 기록·블로그지수 — 0017 `blog_metric_snapshots`
- 행: 블로그 계정·도구·지표·값/단위·측정일·근거 URL·메모. `/analytics`에 블로그 필터와 플랫폼별 도구 묶음을 표시.
- 네이버: 블스피(지수·누락), 블랙키위(키워드), 블로그AI(금칙어·본문 진단).
- 구글·워드프레스·티스토리: Google Search Console(유입, CSV 가져오기), Ubersuggest(키워드·SEO), Microsoft Clarity(이탈 구간).
- 블로그지수: 외부 도구가 표시한 값을 도구명·측정일과 함께 기록하고 추이를 보여 준다. 네이버 공식 지표가 아니라는 안내를 표시하며 자체 계산 점수는 만들지 않는다.

### W9~11 리뷰 수정 — 0018 (완료 2026-11-12)
- DB·API: 새로 연결하는 blog_id는 active 계정만 허용(기존 값 유지는 허용). 근거 URL 스킴 검사를 앱·DB 모두 대소문자 무시로 통일. 키 정규화는 JS와 SQL 모두 탭·줄바꿈까지 같은 규칙.
- 수익 필터: 사이트 합계는 "계정 미배분 합계"로 따로 표시해 필터끼리 겹치지 않게 한다. 귀속과 글 연결 모두 publishedUrl 우선, remote.url 대체 규칙을 같게 쓴다.
- 트렌드 점수: 같은 블로그·키워드·출처에서 기간 안 지표별 최신값을 합쳐 계산한다. 세 값 중 하나라도 없으면 N/A.
- 같은 파일 안에서 키가 같은데 값이 다른 행은 "충돌"로 따로 보고한다(트렌드·성과).
- 상한에 걸리면 그 행의 지표를 하나도 넣지 않는다.
- 표의 작업 셀은 기존 `table-actions` 래퍼를 쓴다.

#### 0018 상세 (2026-11-12 challenger 반영·사용자 결정)
- 결정: 트렌드 점수 묶음 = 블로그·카테고리·키워드·출처(카테고리별 별도 점수). 보관(archived) 계정에는 새 연결·새 기록 모두 차단, 기존 값 유지·조회·중복 재가져오기(무시)만 허용.
- 정규화 규칙(JS·SQL 동일): NFKC → 공백 6종(U+0020·\t·\n·\r·\f·\v) 연속을 스페이스 하나로 → 앞뒤 자르기 → 소문자. NBSP·전각 공백은 NFKC가 스페이스로 바꾼다. U+FEFF·U+2028·U+2029·U+1680은 양쪽 모두 건드리지 않는다. SQL: `lower(btrim(regexp_replace(normalize(x, NFKC), '[ \t\n\r\f\v]+', ' ', 'g')))`(로케일 무관 명시 집합, 바깥 btrim). JS: `/[ \t\n\r\f\v]+/g`. 대상 열: `keywords.phrase_key`(0003), 0016 키 3개, 0017 `metric_key`·`dimension_key`. `ALTER ... SET EXPRESSION`으로 적용하고, 그 전에 새 키로 겹치는 행이 있으면 RAISE로 중단. 같은 입력의 고정 문자 표 테스트를 `supabase/tests/rls.sql`과 JS 테스트에 둔다.
- active 검사: keywords·articles(update 시 blog_id가 바뀔 때만, insert 시 non-null이면), keyword_trends·blog_metric_snapshots(insert). `select status ... for share`. 단 trends·snapshots insert에서 같은 키 행이 이미 있으면 검사·상한을 건너뛰고 NEW 반환(ON CONFLICT DO NOTHING이 무시). articles는 별도 트리거로 둔다(0014 `enforce_article_rules` 재정의 금지).
- 상한: 중복 키는 상한 계산 전에 통과. 상한 count 전에 `pg_advisory_xact_lock(hashtext('<table>:'||workspace_id))`. 상한 초과 메시지는 기존 문구 유지, 테스트로 고정.
- 계정 모드 전송: 묶음을 CSV 행 경계로 자른다(한 행의 지표가 두 묶음에 나뉘지 않음). 경계 테스트 추가.
- URL 스킴: DB `~*`, 앱 `/i` 유지.
- 한계(수용): 소문자화는 JS `toLowerCase`와 PG `lower()`(collation 의존)라 Σ·İ 등 일부 문자에서 다를 수 있다. 한글·영문은 같고 DB 판정이 최종이다.

## 검증 묶음

- W8(W11 뒤로 이동): 팀·인증·수익·AI 검수·새 기능의 브라우저 흐름, 키보드 조작, 저장 실패, 3구간 화면. 실제 WordPress 컨테이너로 slug 선조회와 slug 유지를 확인한다. AI는 가짜 서버로 검증하고 실키 미검증을 유지 표기한다.

## 사용자 승인·외부 자원이 필요한 단계 (실행 직전 확인)

- OpenAI 실제 키 호출: 키 없음.
- 클라우드 Supabase 생성·마이그레이션 적용, https 운영 배포, 운영 메일 설정: 비용·외부 공개 발생.
- M4 파일럿: 실제 사용자 3~5명 필요, 대행 불가.
