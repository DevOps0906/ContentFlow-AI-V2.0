# 로컬 Supabase 사용자 가이드 (Docker)

작성일 2026-11-12. 이 PC의 Docker에서 Supabase를 실행·관리하는 명령 모음이다. 로컬과 Cloud 구분, Cloud 전환 절차는 [SUPABASE_ENVIRONMENTS.md](SUPABASE_ENVIRONMENTS.md)를 본다.

모든 명령은 **저장소 루트**(`D:\WorkSpace\DEV\ContentFlow-AI-V2.0`)에서 PowerShell로 실행한다. 사전 조건은 Docker Desktop 실행이다.

## 1. 구성 한눈에 보기

| 구성 | 주소·포트 | 용도 |
|---|---|---|
| API (Kong) | http://127.0.0.1:60321 | 앱 서버가 호출하는 Supabase API. 컨테이너 안에서는 `http://host.docker.internal:60321` |
| PostgreSQL | 127.0.0.1:60322 | DB 직접 접속 |
| Studio | http://127.0.0.1:60323 | 웹 관리 화면(표·SQL·사용자) |
| 메일함 (Inbucket) | http://127.0.0.1:60324 | 가입 확인·비밀번호 복구 메일 확인(실제 발송 안 됨) |
| 웹 앱 컨테이너 | http://127.0.0.1:3410 | ContentFlow 앱 |

포트 설정은 `supabase/config.toml`에 있다. 이 PC에는 다른 프로젝트의 Supabase도 떠 있으니, 컨테이너 이름이 `_ContentFlow-AI-V2.0`로 끝나는지 확인한다.

## 2. 매일 쓰는 명령

| 하고 싶은 일 | 명령 |
|---|---|
| Supabase 시작 | `pwsh scripts/supabase-local.ps1 start` |
| 상태·주소·키 확인 | `pwsh scripts/supabase-local.ps1 status` |
| Supabase 중지 (데이터 유지) | `pwsh scripts/supabase-local.ps1 stop` |
| 앱 시작 (이미지 다시 빌드) | `docker compose up -d --build` |
| 앱 중지 | `docker compose down` |
| 앱 로그 보기 | `docker compose logs -f web` |
| 앱 상태 확인 | `curl http://127.0.0.1:3410/api/health` → `{"ok":true}` |

PC를 재부팅하면 Docker Desktop을 켠 뒤 "Supabase 시작"과 "앱 시작"을 차례로 실행한다. `status`는 publishable 키와 secret 키를 출력하므로 화면 공유나 로그 저장에 주의한다. secret(service role) 키는 앱 `.env`에 넣지 않는다.

## 3. 데이터베이스 변경 (마이그레이션)

| 하고 싶은 일 | 명령 |
|---|---|
| 새 마이그레이션 적용 (데이터 유지) | `pwsh scripts/supabase-local.ps1 migrate` |
| 적용된 마지막 버전 확인 | `docker exec supabase_db_ContentFlow-AI-V2.0 psql -U postgres -Atc "select max(version) from supabase_migrations.schema_migrations;"` |
| DB 규칙(RLS·트리거) 테스트 | `pwsh scripts/supabase-local.ps1 test` |
| **DB 초기화 (모든 데이터 삭제)** | `pwsh scripts/supabase-local.ps1 reset -Confirm` |

- 마이그레이션 파일은 `supabase/migrations/0001~`이다. 이미 적용된 파일은 고치지 않고 다음 번호로 새 파일을 만든다.
- `reset`은 회원·글·설정을 모두 지우고 0001부터 다시 적용한다. 실행 전에 4장의 백업을 받는다.

## 4. 백업과 복원

| 하고 싶은 일 | 명령 |
|---|---|
| 데이터 백업 (회원 + 앱 데이터) | `docker exec supabase_db_ContentFlow-AI-V2.0 pg_dump -U postgres -d postgres --data-only --schema=auth --schema=public > backup.sql` |
| 구조(스키마)만 백업 | `npx supabase db dump -f schema.sql` |
| 복원 (빈 DB에) | `pwsh scripts/supabase-local.ps1 reset -Confirm` 후 `Get-Content backup.sql \| docker exec -i supabase_db_ContentFlow-AI-V2.0 psql -U postgres -d postgres` |

- 백업 파일에는 회원 이메일과 비밀번호 해시가 들어 있다. 저장소에 커밋하지 말고 안전한 곳에 둔다.
- 복원은 같은 마이그레이션 버전의 DB에 넣어야 한다. 버전이 다르면 먼저 `migrate`로 맞춘다.

## 5. DB 직접 보기

| 방법 | 접속 |
|---|---|
| Studio (웹) | http://127.0.0.1:60323 → Table Editor, SQL Editor, Authentication → Users |
| DB 클라이언트 (DBeaver 등) | Host `127.0.0.1`, Port `60322`, DB `postgres`, User `postgres`, Password `postgres` |
| 연결 문자열 | `postgresql://postgres:postgres@127.0.0.1:60322/postgres` |
| 터미널 | `docker exec -it supabase_db_ContentFlow-AI-V2.0 psql -U postgres` |

자주 보는 표: 회원 `auth.users`, 글 `public.articles`, 키워드 `public.keywords`, 트렌드 `public.keyword_trends`, 성과 `public.blog_metric_snapshots`. 전체 관계도는 [ERD](../03-database/ERD.mmd), 설명은 [DATABASE_SCHEMA 8절](../03-database/DATABASE_SCHEMA.md).

관리자(postgres)로 접속하면 앱의 보안 규칙(RLS)이 적용되지 않는다. 직접 수정·삭제는 그대로 반영되므로 조회 위주로 쓴다.

예시 쿼리:

```sql
select email, created_at from auth.users order by created_at desc;
```

## 6. 앱과 연결하는 환경 변수

앱 컨테이너는 `.env`를 먼저 읽고, 그다음 `.env.local`(또는 `ENV_FILE`로 지정한 파일)을 읽는다. 두 파일 모두 git에 올라가지 않는다. 처음 설정할 때는 `.env.local.example`을 복사해서 쓴다.

| 변수 | 로컬 값 |
|---|---|
| `SUPABASE_URL` | `http://host.docker.internal:60321` |
| `SUPABASE_PUBLISHABLE_KEY` | `status` 출력의 publishable 키 |
| `APP_URL` | `http://localhost:3410` 또는 `http://127.0.0.1:3410` |
| `COOKIE_SECURE` | `false` (로컬 http) |

값을 바꾼 뒤에는 `docker compose up -d`로 앱을 다시 띄운다. 로그인 후 설정 → 환경설정 화면에 "Docker 로컬 Supabase"가 보이면 연결이 정상이다.

## 7. 문제 해결

| 증상 | 확인·조치 |
|---|---|
| 앱이 로그인 화면에서 진행되지 않음 | `status`로 Supabase가 떠 있는지 확인한다. 꺼져 있으면 `start`를 실행한다 |
| 포트 사용 중 오류 (`start` 실패) | 같은 포트를 쓰는 다른 프로그램을 끄거나 `supabase/config.toml` 포트를 바꾼다. 포트를 바꾸면 `.env`의 `SUPABASE_URL`도 함께 바꾼다 |
| 비밀번호 복구 메일이 안 옴 | 실제 발송은 하지 않는다. http://127.0.0.1:60324 메일함에서 확인한다 |
| 앱 컨테이너에서 Supabase 접속 실패 | `docker compose exec web wget -qO- http://host.docker.internal:60321/auth/v1/health` |
| 마이그레이션이 적용되지 않음 | `migrate`를 실행한 뒤 3장의 버전 확인 명령으로 확인한다 |
| 디스크를 정리하고 싶음 | `stop`은 데이터를 유지한다. 데이터까지 지우려면 `npx supabase stop --no-backup`(복구 불가) |
