# Capacitor 모바일 W0 계획 (2026-11-12, challenger 검토 반영)

근거: platform-docs `Capacitor/README.md`(2·4·6장, 확인일 2026-10-14) — 저장소 밖 문서라 필요한 규칙을 아래에 옮겨 적는다. 불변 규칙: `AGENTS.md`.
사용자 결정(2026-11-12): 가이드 W0 골격으로 진행. Supabase는 로컬(Docker) 유지.

## 가이드에서 가져온 규칙
- 화면은 정적 번들(Vite + React)로 앱에 싣는다. 운영 빌드에 `server.url`(원격 셸) 금지, `cleartext: false`, `androidScheme: https`, 운영 빌드 웹뷰 디버깅 끔.
- 화면 코드는 `packages/shell-bridge`만 부르고 `@capacitor/*`를 직접 import하지 않는다.
- 토큰은 Preferences·localStorage 금지, Keychain/Keystore 보안 저장소.
- 소셜 로그인은 앱 내부 WebView 금지(시스템 브라우저 + 딥링크) — W0 범위 밖, 이메일 로그인만.
- 앱 번들에 서버 키·LLM 키·service role 금지. 외부 링크는 시스템 브라우저.
- 앱 안 결제 없음(전략 c). 백그라운드 긴 작업은 서버에서.

## 범위 (W0 = 가이드 M-001, M-002 + 로그인에 필요한 T-C1·M-003 최소)
| ID | 작업 | 경로 |
|---|---|---|
| CF-M-001 | 앱 골격: Vite + React + TS, `capacitor.config.ts`, Android 프로젝트 생성(iOS는 Mac 필요 — 설정만, 프로젝트 생성은 보류) | `apps/mobile/**` |
| CF-M-002 | `NativeBridge` 인터페이스(platform, openExternal, secureStore, onAppUrlOpen) + web 구현 + Capacitor 구현 | `packages/shell-bridge/**` |
| CF-M-T1 | 서버 API Bearer 세션: `Authorization: Bearer <access_token>`이면 쿠키 대신 그 토큰으로 Supabase 클라이언트 생성(RLS 그대로). 토큰 발급 `POST /api/auth/token`(이메일·비밀번호), 갱신 `POST /api/auth/token/refresh`, 폐기 `POST /api/auth/token/revoke`. Bearer 요청은 sameOrigin 대신 CORS 허용 목록(`https://localhost`, `capacitor://localhost`)만 | `apps/web/src/**` |
| CF-M-003 | 보안 저장소 어댑터(커뮤니티 플러그인 1개 선정: 유지 상태·라이선스 기록) | `packages/shell-bridge/capacitor/secure-store/**` |
| CF-M-005a | 모바일 화면 1차: 로그인, 글 목록(상태 필터), 글 상세(읽기 전용, React 텍스트), 승인 대기 확인. 하단 탭, 안전 영역 | `apps/mobile/src/**` |

## challenger 반영 (2026-11-12) — 사용자 결정: W0 Bearer는 읽기 전용
1. proxy(`apps/web/src/proxy.ts`): OPTIONS는 CORS 허용 Origin이면 204+CORS 헤더로 바로 응답. `Authorization: Bearer`가 있는 요청은 쿠키 확인 없이 통과(검증은 route). 401 응답에도 허용 Origin이면 CORS 헤더.
2. Bearer 허용 목록: W0는 GET만 — 글 목록·상세, 세션 확인(`/api/session` 등 화면에 필요한 GET)만. 그 밖의 모든 라우트(비밀번호 변경, AI, 발행, 모든 쓰기)는 Bearer면 403. 공용 `requireAccount`에 "bearer 허용 여부" 인자를 두고 기본값 거부. 비허용 라우트 403 테스트.
3. CORS 허용 Origin은 env `MOBILE_ALLOWED_ORIGINS`(쉼표). 기본 `https://localhost,capacitor://localhost`. Supabase 대상이 cloud이면 http Origin 포함 시 계정 모드 거부(supabase-target issues), 테스트.
4. 토큰 라우트는 쿠키 어댑터 없는 `persistSession:false` 클라이언트. Authorization 헤더가 있으면 쿠키를 읽지 않고 실패 시 401(쿠키 대체 금지). 헤더+쿠키 동시 전송 테스트.
5. `/api/auth/token`·`/refresh`에 IP 기준 sharedLimited(token 10/분, refresh 30/분) + 기존 이메일 기준 제한.
6. revoke는 `signOut({ scope: "local" })`. e2e: revoke 후 refresh 실패. access token은 만료(기본 1시간)까지 유효할 수 있음을 문서에 명시하고 테스트는 refresh 실패로 고정.
7. shell-bridge refresh는 single-flight(동시 요청 1회) 테스트.
8. 워크스페이스: Bearer는 헤더 `X-Workspace-Id`를 받되 멤버십 검증, 없으면 첫 워크스페이스.
9. dev/prod 스위치는 `CAP_ENV` 하나로 묶고, release 전 생성된 `android/app/src/main/assets/capacitor.config.json`과 Manifest(usesCleartextTraffic)를 검사하는 스크립트 `apps/mobile/scripts/check-release.mjs`.
10. web 구현 secureStore는 메모리 전용(새로고침 시 재로그인). 플러그인은 Capacitor 8 peer 지원·최근 릴리스·라이선스·Android 백업 제외(allowBackup=false 또는 backup rules) 기준으로 선정, 실기기 검증 전까지 CF-M-003은 "부분".
11. 루트 workspaces에 apps/mobile·packages/shell-bridge 추가 후 web typecheck·test·build·W8 e2e 회귀.
12. appId는 스토어 등록 직전 사용자 확인.

범위 밖: 구글 로그인(M-004), 푸시(M-007~8), 계정 삭제 화면(M-009 — 스토어 제출 전 필수), 오프라인, 스토어 제출, iOS 프로젝트.

## 환경·빌드
- API 주소는 빌드 시 `VITE_API_BASE`. 운영 빌드는 https만 허용(빌드 스크립트가 검사).
- 개발: 에뮬레이터 → 로컬 Docker 앱(`http://10.0.2.2:3410`)은 http라 `cleartext`가 필요하다. 개발 빌드(`CAP_ENV=dev`)에서만 cleartext·server.url 허용, 운영 빌드 설정에 둘 다 없음을 테스트로 고정.
- appId: `com.devops0906.contentflow`(스토어 등록 전까지 변경 가능, 등록 후 불가).
- 이 PC에는 JDK·Android SDK가 없다 → `npx cap add android`·`cap sync`·웹 번들 빌드까지 검증, APK 빌드·실기기 실행은 Android Studio 설치 후.
- 새 의존성: `@capacitor/core|cli|android|app|browser` 8.6.x, `vite`, `@vitejs/plugin-react`, `react`/`react-dom`(웹과 같은 버전), 보안 저장소 플러그인 1개. `security-baseline` 절차(라이선스·감사).

## 완료 조건
- `apps/mobile` 빌드 성공, `npx cap sync android` 성공, 운영 설정에 `server.url`·cleartext 없음(테스트).
- 화면 코드에서 `@capacitor/` import 0건(테스트/grep).
- Bearer: 토큰 발급·갱신·폐기 e2e, 다른 사용자 데이터 접근 불가(RLS), 잘못된 토큰 401, 허용 목록 밖 Origin CORS 거부, 쿠키 경로 회귀 없음(W8 e2e 재실행).
- 브라우저(모바일 폭)에서 apps/mobile 개발 서버로 로그인→목록→상세 확인.
- 기존 typecheck·test·build·DB 테스트 통과, `npm audit` high 이상 0.
