# ContentFlow nomad DB 전환 절차 (운영 데이터 이관)

옛 `public` 스키마(`supabase/legacy-migrations/0001~0027`)의 운영 데이터를 nomad 구조(`nomad_core` 조직·멤버·구독 + `nomad_contentflow` 제품 표)로 옮기는 1회 절차다.
스키마는 `supabase/migrations/`로만 `db push`하고, 데이터 복사는 사람이 `supabase/nomad-cutover/`의 psql 스크립트로 실행한다.
값 대응 정본: nomad-supabase-module `products/contentflow/existing.md` "운영 데이터 이관" 절.

## 파일
| 파일 | 내용 |
|---|---|
| `supabase/nomad-cutover/01_freeze.sql` | 옛 표 26개 쓰기 권한 회수(anon·authenticated·service_role·public, 기록) + 쓰기 거부 트리거 + auth.users 옛 트리거·pg_cron 작업 중지(ContentFlow는 둘 다 0건). 기록은 비노출 스키마 `nomad_cutover` |
| `supabase/nomad-cutover/01_freeze_undo.sql` | 기록대로 정확히 되돌림(권한·트리거·cron 복구, `nomad_cutover` 삭제) |
| `supabase/nomad-cutover/02_copy.sql` | 한 트랜잭션 복사. 기본 dry-run(rollback), `-v apply=1`일 때만 commit. 시작 검사·끝 검사가 하나라도 어긋나면 중단 |
| `supabase/nomad-cutover/check.sh` | 로컬 일회용 DB(`cutover_contentflow`)에서 전 과정을 합성 데이터로 검사 |

Storage 버킷이 없으므로 `03_storage`는 없다.

## 실행 순서
모든 SQL은 대시보드의 **postgres** 연결 문자열로 실행한다(`DB=<연결 문자열>`). 각 단계의 출력을 작업 기록에 남긴다.

0. 로컬 검사: `bash supabase/nomad-cutover/check.sh` → `PASS`.
1. **백업**: 대시보드 Database → Backups에서 시점 확인(PITR이면 시각 기록), 추가로 `npx supabase db dump --db-url "$DB" -f backup_schema.sql` 와 `--data-only -f backup_data.sql`.
2. **노출 스키마 추가(앱 배포 전)**: 대시보드 API 설정 Exposed schemas에 `nomad_contentflow` 추가(`config.toml`의 `[api].schemas`와 같게). 옛 앱은 `public`만 쓰므로 영향 없음.
3. **점검 공지 후 쓰기 중지**: 옛 앱을 점검 모드로 두고 `psql "$DB" -v ON_ERROR_STOP=1 -f supabase/nomad-cutover/01_freeze.sql`. 출력의 `NOMAD_CUTOVER_FROZEN: 권한 회수 N건…`을 기록한다.
   - 이 동안 옛 표 쓰기는 모두 실패한다(사용자 삭제도 옛 멤버십 cascade 때문에 실패 — 전환 창 동안 계정 삭제 금지).
4. **옛 마이그레이션 기록 정리**: `npx supabase migration repair --status reverted 0001 0002 … 0027 --db-url "$DB"`(옛 버전 27개 전부). 옛 표·함수는 지워지지 않는다.
5. **스키마 적용**: `npx supabase db push --db-url "$DB"`. `nomad_core` 백필이 기존 사용자마다 개인 조직을 만든다.
6. **플랜·한도 시드(운영자)**: `nomad_core.plans`에 contentflow A/B/C, `nomad_core.plan_limits`에 `included_blogs`·`max_blogs`·`overage_allowed`. 옛 값과 같게 하려면 `supabase/nomad-cutover/test/20_plans_seed.sql`과 같은 값(free=1/1/0, basic=3/10/1, pro=10/30/1). 02는 옛 workspace 이용권과 값이 다르면 중단한다.
7. **dry-run**: `psql "$DB" -v ON_ERROR_STOP=1 -f supabase/nomad-cutover/02_copy.sql` → `NOMAD_CUTOVER_VERIFIED…` 와 `NOMAD_CUTOVER_DRY_RUN_OK`. `NOMAD_CUTOVER_ABORT`면 메시지 목록을 보고 원인을 처리한 뒤 다시(아래 표).
8. **적용**: `psql "$DB" -v ON_ERROR_STOP=1 -v apply=1 -f supabase/nomad-cutover/02_copy.sql` → `NOMAD_CUTOVER_APPLIED`.
9. **새 앱 배포·확인**: 로그인 → 조직 목록에 옛 workspace가 team 조직으로 보이는지, 글·블로그·분석 연결·발행 큐가 보이는지, 다른 조직 데이터가 안 보이는지.
10. **쓰기 재개**: 새 앱의 점검 모드 해제. **여기부터 되돌릴 수 없다.** 옛 표는 멈춘 채로 둔다(지우지 않음, 정리는 별도 작업).

## 중단 메시지
| 메시지 | 처리 |
|---|---|
| `NOMAD_CUTOVER_NOT_FROZEN` | 3단계(01)부터 |
| `NOMAD_CUTOVER_TARGET_NOT_EMPTY` | 이미 복사됨 — 재실행하지 않는다. 다시 해야 하면 아래 되돌리기 |
| `NOMAD_CUTOVER_ANONYMOUS` | 익명 사용자 소유 행 — 버리지 않고 건수를 팀장에게 보고, 이관 중단 |
| `NOMAD_CUTOVER_PLAN_UNMAPPED` / `PLAN_MISSING` / `ENTITLEMENT_MISMATCH` | 대응 없는 옛 플랜·시드 누락·운영자 개별 한도 — 6단계 값 확인, 대응 없는 값이면 중단 |
| `NOMAD_CUTOVER_GRACE_ACTIVE` | 옛 유예(grace_until)가 남은 workspace — 새 구조에 유예가 없으므로 운영자 판단 후 진행 |
| `NOMAD_CUTOVER_NO_PERSONAL_ORG` | 5단계 백필이 안 된 사용자 — db push 결과 확인 |
| `NOMAD_CUTOVER_OWNER_MISSING` | owner 멤버십 없는 workspace — 옛 데이터 정정 후 |
| `NOMAD_CUTOVER_CHECK_VIOLATION` | 새 표 check에 걸리는 옛 행(예: 0012 이전 수익 행의 timezone 없음, 옛 제약 NOT VALID) — 행 처리 방법을 팀장이 정한 뒤 |
| `NOMAD_CUTOVER_VERIFY_FAILED` | 끝 검사 불일치 — 트랜잭션은 rollback됨. 출력 그대로 보고 |

## 되돌리기 (쓰기 재개 전까지만)
- **8단계(apply) 전**: `psql "$DB" -v ON_ERROR_STOP=1 -f supabase/nomad-cutover/01_freeze_undo.sql` 후 옛 앱 점검 해제. db push로 생긴 `nomad_*` 스키마·개인 조직은 비어 있거나 옛 앱이 쓰지 않으므로 둬도 된다. 다시 시도할 때 4·5단계는 이미 끝난 상태로 이어간다.
- **8단계 뒤 ~ 10단계 전**: 새 앱을 내리고 `01_freeze_undo.sql` → 옛 앱 재개. 옮긴 행은 옛 앱이 읽지 않는다. 같은 데이터로 다시 옮기려면 대상이 비어 있어야 하므로 1단계 백업 시점으로 복원(PITR)한 뒤 3단계부터.
- **10단계 뒤**: 되돌리지 않는다(새 쓰기는 nomad 표에만 있다). `01_freeze_undo.sql`도 실행하지 않는다.
