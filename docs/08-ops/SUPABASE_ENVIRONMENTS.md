# Supabase 환경 분리 (로컬 Docker / 클라우드)

> 클라우드 프로젝트 생성은 비용이 발생할 수 있고, 외부 공개(도메인·회원가입 개방)는 팀장/사용자 승인 후에만 진행한다.

## 1. 분류표

| 항목 | 로컬 (Docker 스택) | 클라우드 (supabase.com) |
|---|---|---|
| env 예시 | `.env.local.example` -> `.env.local` | `.env.cloud.example` -> `.env.cloud` |
| 실행 | `$env:ENV_FILE=".env.local"; docker compose up -d --build` | `$env:ENV_FILE=".env.cloud"; docker compose up -d --build` |
| SUPABASE_URL | `http://host.docker.internal:60321` | `https://<project-ref>.supabase.co` |
| 키 | `npx supabase status`의 publishable | 대시보드 publishable 키 |
| COOKIE_SECURE | false | true (기본값) |
| APP_URL | `http://localhost:3410` | https 필수 |
| 마이그레이션 | `scripts/supabase-local.ps1 migrate` | `scripts/supabase-cloud.ps1 push -Yes` |
| 비용/공개 | 없음 | 요금 발생 가능, 외부 공개 승인 필요 |

앱 판별 규칙: URL host가 localhost, 127.0.0.1, ::1, host.docker.internal이면 local, 그 외는 cloud(https와 https APP_URL 필수). secret/service_role 키는 어떤 env에도 넣지 않는다.

- cloud 대상에서 SUPABASE_URL이 http이면 앱은 계정 모드를 끄고 로컬(브라우저 저장) 모드로 동작한다.
- `/api/health`는 `{ok:true}`만 반환한다. 연결 대상·문제 목록은 설정 화면(로그인 필요)에서 확인한다.
- 클라우드 스크립트의 diff/push는 실행 전 연결된 project-ref(`supabase/.temp/project-ref`)를 출력하고, 링크가 없으면 중단한다.

## 2. 로컬 절차 (`scripts/supabase-local.ps1`)
`start` -> `status`(키 확인, `.env.local` 작성) -> `migrate` -> `test`(RLS, Docker 필요) -> `stop`. `reset`은 DB를 지우므로 `-Confirm` 필수.
포트는 `supabase/config.toml`(60321~). 로컬 Auth의 site_url/redirect도 같은 파일에서 관리한다.

## 3. 클라우드 대시보드 설정 (Authentication)
- URL Configuration: Site URL = `https://<your-app-domain>`; Redirect URLs = `https://<your-app-domain>/auth/callback` (정확한 URL만).
- SMTP: 운영용 커스텀 SMTP 설정(기본 메일러는 발송 제한이 낮음). 발신 주소·템플릿 확인.
- 이메일 확인(Confirm email): 켠다. 가입/재설정 링크는 APP_URL 기준.
- API 키: 앱에는 publishable 키만 사용. secret/service_role 키와 DB 비밀번호는 앱 env·로그·커밋에 넣지 않는다.
- CLI 비밀(`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`)은 셸 환경변수로만 주고, 스크립트는 출력하지 않는다.

## 4. 마이그레이션 적용 순서 (0001 -> 0018, 번호순)
0001 core_tenancy, 0002 article_content_and_state_rules, 0003 keywords, 0004 team_and_roles, 0005 keyword_link_and_revenue, 0006 rate_limits, 0007 agent_runs, 0008 state_events_and_delivery_attempts, 0009 published_url, 0010 display_profiles_and_approval_hash, 0011 site_checks, 0012 costs_improvements_revenue_period, 0013 brief_review_title_template, 0014 brief_before_review_keyword_guard, 0015 blog_accounts, 0016 keyword_trends, 0017 blog_metric_snapshots, 0018 review_fixes.
CLI가 번호순으로 적용한다. 기존 파일 수정 금지(변경은 새 번호로 추가).

클라우드 절차: `link -ProjectRef <ref>` -> `diff`(dry-run) -> 검토 -> `push -Yes`. `-Yes` 없는 `push`는 dry-run만 하고 중단한다.

## 5. 전환 체크리스트 (로컬 -> 클라우드)
- [ ] 비용·프로젝트 생성·외부 공개 승인 받음
- [ ] 로컬에서 `migrate`, `test` 통과
- [ ] 클라우드 프로젝트 생성, 대시보드 Auth 설정(3번) 완료
- [ ] `link` -> `diff` 결과 0001~0018 확인 -> `push -Yes`
- [ ] `.env.cloud` 작성(publishable 키만, https, COOKIE_SECURE=true, APP_URL https)
- [ ] `ENV_FILE=.env.cloud`로 기동, 가입·이메일 확인·로그인·저장 확인
- [ ] 공개 전 ALLOW_SIGNUP 정책 결정, 비밀이 커밋/로그에 없는지 확인
