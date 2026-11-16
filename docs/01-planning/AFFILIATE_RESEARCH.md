# 블로그 자동화 경쟁 조사 — 레퍼런스 분석 · 브랜드커넥트 · 쿠팡 파트너스 (2026-11-16 기준)

기획: [AFFILIATE_COMMERCE.md](AFFILIATE_COMMERCE.md) · 조사: 2026-11-16 웹 조사(원문 미열람 항목은 [미확인])

등급: **[공식]** 플랫폼·정부 1차 문서/보도자료 · **[자료]** 언론·개발자 사례·판매 페이지(2차) · **[미확인]** 공식 근거 못 찾음
조사 한계: partners.coupang.com 도움말은 SPA라 본문을 직접 못 읽음. 네이버 운영정책 원문도 직접 확인 못 함. 로그인 페이지 미시도.

## 1. 핵심 결론
1. 네이버 블로그 **공식 글쓰기 API는 2020-05-06 종료**. 지금 네이버 자동 발행 도구는 전부 **브라우저 자동화(Playwright/Selenium·매크로)** 로 SmartEditor를 조작한다. [자료: 언론]
2. 쿠팡 파트너스는 **공식 Open API(HMAC 키) 존재**: 상품검색·딥링크·골드박스·카테고리 베스트·쿠팡PL·리포트. 최종 승인 계정만 키 발급. [자료: SDK·플러그인 문서가 공식 문서 인용]
3. 네이버 브랜드커넥트(쇼핑 커넥트)는 **공개 API 미확인** → 자동화 도구는 로그인 세션으로 상품검색·링크발급 화면을 스크래핑한다. [미확인/자료]
4. 공정위 지침(2024-12-01 시행): 블로그는 **제목 또는 첫 부분**에 경제적 이해관계 표시, "소정의 수수료를 받을 수 있음" 같은 모호 문구 불가, **구매링크+판매실적 수수료**도 공개 대상. [공식 보도자료 존재 + 내용은 자료]
5. 네이버는 제휴 링크 자체를 금지하는 공식 조항은 미확인. 단 **자동화 수단의 기계적 반복 게재·동일 콘텐츠 반복**은 이용제한·검색 품질 조치 대상. [자료]
6. 해외 SaaS(Koala·Byword·ZimmWriter)는 **SERP 분석 → 원고 → WordPress 직접 발행 → Amazon 라운드업**이 표준 흐름. 한국은 크몽형 설치 프로그램이 주류이고 SaaS형은 드묾. [자료]

## 2. 대표 서비스·도구 비교
| # | 서비스/유형 | 기능 흐름 | 데이터 경로 | 발행 방식 | 등급 |
|---|---|---|---|---|---|
| 1 | KoalaWriter (해외 SaaS) | 키워드 → 실시간 SERP 분석(상위 글 엔터티·의미 모델링) → 장문 원고 → Amazon roundup/review 유형 | SERP 크롤링 + LLM. Amazon API 사용 여부 미명시 | WordPress 직접 발행(초안 검토 가능) | [자료: 공식 홈] |
| 2 | Byword / ZimmWriter (해외) | 대량·프로그래매틱 생성, 내·외부 링크 자동, 인용 삽입, 색인 제출 | LLM + 웹 검색 | CMS 직접 발행(WP 표준) | [자료: 비교글] |
| 3 | Content Egg (WP 플러그인, Coupang 모듈) | 키워드로 쿠팡 상품 검색 → 글에 상품 블록 삽입 → 가격 재검색 갱신 | **쿠팡 파트너스 Open API 검색**(요청당 최대 10개, 제목·이미지·가격만, ID 조회 없음) | WordPress | [자료: 플러그인 공식 문서] |
| 4 | 개인 구축 브랜드커넥트 자동화(GPTers 사례) | 키워드 → BC 상품검색 → Claude가 상품 선택 → 홍보링크(naver.me) 발급 → 원고(제목·대가 고지·소개·상품블록·가이드) → 이미지·OGP 카드 치환 → 발행 | **Playwright로 로그인 세션 조작**(공식 API 없음), CSS 셀렉터 자주 깨짐 | SmartEditor SE5 브라우저 자동화 | [자료: 개발 사례] |
| 5 | 크몽 판매 프로그램(쿠팡·쇼핑커넥트 N사 자동포스팅) | 키워드/상품 → Gemini/OpenAI로 글 → 상품 이미지·링크 → 임시저장/예약발행 | 데이터 경로 미공개, 사용자가 AI 키·네이버 계정 제공 | 설치형 프로그램이 계정 직접 조작 | [자료: 판매 페이지] |
| 6 | 레퍼런스·경쟁 블로그 분석: 블랙키위·블로그스탠다드·엔서포터·블덱스 | 키워드 조회수/경쟁도, 상위 글 글자수·개설일·방문자, "블로그 지수"(비공식 개념) | 네이버 검색 결과·검색광고 키워드 도구 기반 추정(크롤링 추정). 블덱스는 종료설 상충 | 발행 기능 없음(분석 전용) | [자료] |

## 3. (A) 레퍼런스·경쟁 블로그 분석 구현 방식
- 공식 경로: **네이버 검색 API(블로그)** 로 키워드별 상위 문서 제목·요약·링크·작성일 조회 [공식: developers.naver.com/docs/serviceapi/search/blog/blog.md]. 검색량은 **네이버 검색광고 API 키워드도구** [공식: naver.github.io/searchad-apidoc]. 본문 전문·순위 위치는 API 미제공 → 상용 도구는 결과 페이지 크롤링으로 보충 [자료].
- 해외 SaaS는 SERP 상위 페이지 본문을 수집해 엔터티·헤딩 구조를 추출하고 원고 개요에 반영 [자료: KoalaWriter].
- "블로그 지수"는 네이버 공식 용어가 아님, 외부 업체 추정치 [자료].
- 시사점: 우리 제품은 공식 검색 API + 사용자가 붙여넣은 URL 분석까지만 하고, 크롤링 기반 지수를 "공식"처럼 표시하지 않는 것이 안전.

## 4. (B) 네이버 브랜드커넥트 상품/캠페인 추천 → 글 발행
- 쇼핑 커넥트 정식 출시 2025-07-23: 스마트스토어 판매자가 제휴 상품·수익분배율 설정, 크리에이터가 링크 발급해 블로그·클립 등에 홍보 [자료: 언론]. 2026년 공동구매 기능 추가 [자료].
- 링크 발급은 BC 웹 화면 "링크 발급" → "발급 링크 관리" [자료: 사용 가이드].
- **공개 API 없음(미확인)**: 검색 범위 내 공식 개발자 문서 없음. 모든 자동화 사례가 브라우저 자동화 [미확인/자료].
- 자동화 리스크: 셀렉터 변경, 로그인 세션 자동 조작 = 네이버 비정상 이용 정책 저촉 가능, 판매자도 "대량 발행 시 미노출·저품질 위험" 고지 [자료].
- 시사점: 우리 제품은 **사용자가 BC에서 직접 발급한 링크를 붙여넣는 반자동** 흐름이 안전. 상품 "추천"은 사용자가 입력한 상품 정보 기반으로만.

## 5. (C) 쿠팡 파트너스 활용 발행
| 항목 | 내용 | 등급 |
|---|---|---|
| Base URL | `https://api-gateway.coupang.com/v2/providers/affiliate_open_api/apis/openapi/v1` | [자료: SDK README가 공식 문서 인용] |
| 인증 | Access Key + Secret Key, HMAC-SHA256(CEA) 서명, 서버 시각 GMT 정확해야 함 | [자료] |
| 엔드포인트 | `GET /products/search`(keyword, limit≤10, subId), `POST /deeplink`(쿠팡 URL→단축 제휴링크), `/products/goldbox`, `/products/bestcategories/{id}`, `/products/coupangPL`, 리포트 | [자료: SDK·k-skill·Content Egg] |
| 키 발급 조건 | 파트너스 **최종 승인** 후 "파트너스 API" 메뉴에서 발급 | [자료: Content Egg 문서] |
| 호출 제한 | "1시간 30회 이상 시 24시간 정지"(README 주장), 검색 1분 N회 등 수치 상충 | [미확인] |
| 반환 데이터 | 상품명·이미지·가격·URL 중심, 상세 스펙 없음, 상품ID 단건 조회 없음 | [자료] |
| 딥링크 웹 UI | 상품 URL 붙여넣기 → 생성, `subid`로 채널·글별 성과 구분 | [자료] |
| 광고 운영 규정 | 2025-01 더보기 배너·플로팅 배너 금지, 자동 리디렉션·클릭 위장 금지 | [자료: 언론·분석] |
- 흔한 구현: 키워드 → `/products/search` → LLM이 비교·추천 글 → 링크(이미 제휴 URL) 삽입 → 상단 대가 문구 → WordPress REST API 발행(공식) 또는 네이버는 브라우저 자동화 [자료].
- 네이버 블로그 쿠팡 링크 노출 불이익: 2020년 쿠팡이 "쿠팡 링크 글 노출이 현저히 낮다"고 주장, 네이버는 "광고성 글 악용에 따른 검색 품질" 입장 [자료: 2020 언론]. 현재 공식 차단 조항은 [미확인]. 업계는 과도한 링크·유사 문서·유사 이미지를 원인으로 봄 [자료].

## 6. 표시 의무(공정위 추천·보증 심사지침)
| 항목 | 내용 | 등급 |
|---|---|---|
| 2024 개정 | 2024-11-15 보도자료, 2024-12-01 시행 | [공식: korea.kr 보도자료 존재] |
| 위치 | 블로그 등 문자 매체는 **제목 또는 첫 부분** (기존 하단 표시 불인정) | [자료: 언론, 공식 첨부 PDF 미열람] |
| 범위 | 할인코드·구매링크를 넣은 추천글로 판매실적 수수료를 받는 경우 신설 | [자료: 행정예고 기사] |
| 문구 | "소정의 수수료를 지급받을 수 있음" 등 모호 표현 불가 → "쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다" 형태 권장 | [자료] |
| 2025-12 안내서 | 원칙 4가지(접근성·인식성·명확성·언어), Q&A 25문항 | [자료: 언론] |
| 2026-06-01 | AI 가상인물 추천·보증 표기 의무 추가 | [자료: 검색 요약, 원문 미확인] |
| 쿠팡 정책 | 대가 문구 미기재 시 정산 제외·계정 정지 주장 | [미확인: 블로그 주장] |

## 7. ContentFlow 적용 시사점(팀장 판단용)
1. 쿠팡: 공식 Open API(서버 측 키, HMAC)로 검색·딥링크 연결 가능. 브라우저에 키 노출 금지(AGENTS.md 규칙과 일치).
2. 네이버 발행: 공식 API 없음 → "HTML/텍스트 export + 사용자가 직접 붙여넣기"가 정책상 안전. 계정 자동 조작은 넣지 않는 것을 권장.
3. 브랜드커넥트: 링크는 사용자 입력. "연결됨" 표시 금지(공식 API 없음).
4. 대가 문구: 제휴 링크가 있으면 승인 전에 **첫 부분 고지**를 필수로 검사(누락 시 승인·export 차단).
5. 저품질 회피: 글당 링크 수 상한, 동일 템플릿 반복 경고, 실사용 근거 요구.

## 8. 출처
- 네이버 글쓰기 API 종료(2020-04-13 발표, 05-06 종료): https://newspim.com/news/view/20200413000737 · https://www.i-boss.co.kr/ab-6141-52498
- 쿠팡 링크 노출 논란(2020): https://biz.newdaily.co.kr/site/data/html/2020/06/29/2020062900084.amp.html
- 브랜드커넥트 자동화 개발 사례: https://www.gpters.org/dev/post/building-automatic-naver-brand-81CJV3Dnj2OeRux
- 쇼핑 커넥트 정식 출시: https://ditoday.com/?p=130597 · https://news.bizwatch.co.kr/article/mobile/2025/07/23/0009 · 공동구매: https://byline.network/2026/01/6-300/
- 자동화 현실 검증(2026-09): https://wikidocs.net/blog/@wondergrid/30216/ (본문 403, 검색 요약만)
- 쿠팡 Open API SDK/노드: https://www.pkgstats.com/pkg:coupang-partners-sdk-standalone · https://www.pkgstats.com/pkg:n8n-nodes-coupang-partners · 공식 도움말 https://partners.coupang.com/#help/open-api (SPA, 본문 미열람)
- 쿠팡 검색 API 프록시 문서: https://raw.githubusercontent.com/NomaDamas/k-skill/main/docs/features/coupang-product-search.md
- Content Egg 쿠팡 모듈: https://ce-docs.keywordrush.com/modules/affiliate/coupang-module
- 딥링크·subid 가이드: https://tilnote.io/pages/68fcf47ff08d3091a56f3c0c
- 쿠팡 광고 운영 규정(2025-01): https://www.digitalmarketer.co.kr/insights/coupang-hijack-ads-regulation
- 크몽 자동포스팅 판매 예: https://kmong.com/gig/673684 · https://kmong.com/gig/548204
- KoalaWriter: https://koala.sh/ · Koala/Byword/ZimmWriter 비교: https://resources.rework.com/tools/ai-tools/best-ai-tools-for-bloggers-2026
- 분석 도구(블덱스·블랙키위·엔서포터): https://maily.so/tiyou/posts/g0zmwpm9oql · https://aboda.kr/entry/%eb%b8%94%eb%8d%b1%ec%8a%a4-%ec%a3%bc%ec%9a%94-%ea%b8%b0%eb%8a%a5-%ec%9e%a5%ec%a0%90-%ec%82%ac%ec%9a%a9%eb%b0%a9%eb%b2%95/amp
- 공정위 2024 개정 보도자료: https://www.korea.kr/briefing/pressReleaseView.do?newsId=156660604 · 행정예고: https://www.korea.kr/briefing/pressReleaseView.do?newsId=156646338 · https://www.ftc.go.kr/www/selectReportUserView.do?key=10&report_data_no=10886
- 공정위 2025-12 안내서: https://www.ajunews.com/view/20251202085042877 · 문구 예시: https://foxcg.com/coupang-partners-display/
- 네이버 자동화·어뷰징 정책(2차): https://www.i-boss.co.kr/ab-6141-66374 · https://ditoday.com/?p=121688 · 저품질 논의: https://jab-guyver.co.kr/3068
- 네이버 검색 API(블로그): https://developers.naver.com/docs/serviceapi/search/blog/blog.md · 검색광고 API: https://naver.github.io/searchad-apidoc/
