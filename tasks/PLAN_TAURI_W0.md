# Tauri 데스크톱 W0 계획 (2026-11-12, challenger 검토 반영)

근거: platform-docs `Tauri/README.md`(3·9·10·11·13장, 확인일 2026-10-14) — 저장소 밖 문서. 불변 규칙: `AGENTS.md`.
사용자 결정(2026-11-12): PC에서 웹 앱 **전체 기능**을 쓴다. 앱 안에 Next 서버를 사이드카로 내장한다(가이드 기본안 T-D1 "Vite 셸"과 다름 — 셸에서 편집기 전체를 다시 만들지 않기 위해).

## 구조
- `apps/desktop/src-tauri`: Tauri 2.12.x(Rust). 시작 시 내장 Node 런타임으로 `apps/web` standalone `server.js`를 실행(HOSTNAME=127.0.0.1, 고정 포트), 준비되면 메인 창이 `http://127.0.0.1:<포트>`를 연다. 종료 시 사이드카 종료.
- 메인 창 출처(127.0.0.1)에는 **IPC capability를 주지 않는다**(원격 URL + IPC 금지 규칙). 시작 화면(로딩·오류)만 번들 로컬 페이지에서 최소 명령 사용.
- 외부 링크·새 창은 Rust에서 가로채 시스템 브라우저로 연다.
- 저장: Supabase 미설정이면 기존 로컬 모드(WebView 저장소). 출처가 바뀌면 데이터가 사라지므로 포트는 고정, 사용 중이면 다른 포트로 바꾸지 않고 오류 화면.
- 설정·키: `%APPDATA%\ContentFlow\desktop.env`(Supabase URL·anon, AI 키)를 Rust가 읽어 사이드카 env로만 전달. 번들·설정 파일에 service role 금지.
- 빌드: Windows NSIS(개발용 무서명), macOS는 후속. Node 런타임은 빌드 시 고정 버전(현재 v24 LTS) 복사.

## challenger 반영 (2026-11-12)
- 결정: B1 토큰은 W0에 포함. 계정 모드 메일 링크(재설정·확인) 흐름은 W0 제외(시스템 브라우저로 열려 세션이 앱으로 오지 않음) — DESKTOP_APP.md에 명시.
- **토큰 계약(웹↔데스크톱)**: Rust가 실행마다 32바이트 난수 hex `DESKTOP_TOKEN`과 `DESKTOP_PORT`(고정 34110)를 사이드카 env로 준다. `DESKTOP_TOKEN`이 있으면 proxy가 모든 경로에서 ① Host가 정확히 `127.0.0.1:<DESKTOP_PORT>` ② 쿠키 `cf_desktop`이 토큰과 같음(상수 시간 비교)을 요구, 아니면 403. 예외: `GET /desktop-auth?t=`(Host 검사만, 토큰 일치 시 `cf_desktop` HttpOnly·SameSite=Strict·Path=/ 쿠키 후 `/`로 302), `GET /api/health?nonce=`(Host 검사만, `HMAC-SHA256(token, nonce)` hex 반환). 토큰 미설정(웹·Docker)이면 동작 변화 없음.
- 준비 확인은 TCP가 아니라 health HMAC 일치로만 통과. 사이드카가 죽으면 창을 번들 오류 화면으로 옮기고 자동 재로드 안 함(B2).
- 자식 프로세스는 Windows Job Object(KILL_ON_JOB_CLOSE). `%LOCALAPPDATA%\ContentFlow\sidecar.pid`가 우리 node.exe 경로일 때만 시작 시 정리. 단일 인스턴스 검사가 사이드카 실행보다 먼저(B3).
- 사이드카 env: env_clear 후 허용 목록만(`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `APP_URL`, `COOKIE_SECURE`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `WP_*`, `DESKTOP_*`, `PORT`, `HOSTNAME`, `NODE_ENV`), NODE_OPTIONS 차단. 로그에 env·프롬프트 금지. 키 파일은 평문·사용자 ACL 보호임을 문서화(C4).
- identifier `com.contentflow.desktop`과 포트 34110은 바꿀 수 없는 상수(데이터 위치)로 문서화(C2). 메인 창 CSP는 Next 응답 헤더 몫, W0 범위 밖(C3).
- 패키징: standalone `apps/web/server.js` + `.next/static`·`public` 복사, Node LICENSE 동봉, 설치 크기 측정(상한 200MB)(C5).

## 작업
| ID | 작업 | 경로 |
|---|---|---|
| CF-D-001 | Tauri 골격, 시작 화면, CSP, capability 최소 | `apps/desktop/**` |
| CF-D-002 | 사이드카 실행·준비 확인·종료, 고정 포트, desktop.env 로드 | `apps/desktop/src-tauri/src/**` |
| CF-D-003 | 외부 링크 시스템 브라우저, 단일 인스턴스 | `apps/desktop/src-tauri/src/**` |
| CF-D-004 | 빌드 스크립트(웹 standalone + node 런타임 → resources), NSIS 설치 파일 | `scripts/desktop-build.*`, `apps/desktop/**` |
| CF-D-006 | 웹: 데스크톱 토큰 검사(proxy), `/desktop-auth`, `/api/health` HMAC — 위 계약 | `apps/web/src/**`, `apps/web/tests/**` |
| CF-D-005 | 문서(설치·키 위치·제한), README·NOW | `docs/08-ops/DESKTOP_APP.md` |

## 완료 조건
`cargo check`·`cargo clippy`, `npm run tauri build`로 NSIS 생성, 설치 후 실행 → 대시보드 표시·로컬 모드 글 저장·재시작 후 유지, 외부 링크가 시스템 브라우저로, 토큰 없는 요청·다른 Host 403, 웹 단위 테스트·build 유지. 계정 모드 로그인 후 재시작 세션 유지는 실측(안 되면 제한으로 기록).

## 검토할 위험 (challenger)
로컬 서버 노출(다른 로컬 프로세스·브라우저 페이지의 CSRF/DNS rebinding), 고정 포트 충돌, 사이드카 고아 프로세스, 업데이트 시 데이터 보존, 키 파일 권한, 설치 용량.
