# ContentFlow 모바일 (Capacitor 8, W0 골격)

Vite + React 정적 번들을 Capacitor Android 셸에 싣는다. 계획·규칙: `tasks/PLAN_CAPACITOR_W0.md`.
화면 코드(`src/`)는 `@contentflow/shell-bridge`만 부르고 `@capacitor/*`를 직접 import하지 않는다(테스트로 고정).

## 구현 상태
- CF-M-001 골격, CF-M-002 shell-bridge, CF-M-005a 화면(로그인·글 목록 상태 필터·상세·승인 대기 탭·하단 탭·안전 영역): 구현.
- CF-M-003 보안 저장소: 부분 — 플러그인 연결까지, 실기기 검증 전.
- iOS 프로젝트, 구글 로그인, 푸시, 계정 삭제 화면, 스토어 제출: 범위 밖.
- 읽기 전용 앱: 서버가 Bearer로 GET만 허용한다(편집·승인·발행은 웹).

## 명령 (저장소 루트에서)
| 목적 | 명령 |
|---|---|
| 브라우저 개발 | `npm run dev -w apps/mobile` (`/api`를 `http://127.0.0.1:3410`으로 프록시, 같은 출처라 CORS 없음. 대상 변경: `DEV_API_TARGET`) |
| 웹 번들 | `VITE_API_BASE=https://<서버> npm run build -w apps/mobile` |
| Android 동기화 | `npm run cap:sync -w apps/mobile` (sync 후 allowBackup=false 패치 포함) |
| Android 프로젝트 생성(1회) | `npx cap add android` 후 `node scripts/patch-android.mjs` (apps/mobile에서) |
| 릴리스 검사 | `npm run check:release -w apps/mobile` |
| 테스트 | `npm test -w apps/mobile` / `npm test -w packages/shell-bridge` |

JDK·Android SDK가 있어야 APK를 빌드한다(Android Studio). 이 저장소 작업 PC에서는 `cap add`·`cap sync`까지만 검증했다.

## dev / 운영 스위치: `CAP_ENV`
- 운영(기본): `server.url` 없음, `cleartext` 없음, `androidScheme: https`, `webContentsDebuggingEnabled: false`, `allowMixedContent: false`. `VITE_API_BASE`는 https만(아니면 빌드 실패). 미설정이면 자리표시 주소로 빌드하고 경고하지만, `check:release`가 번들의 API 주소(`build-info.json`)가 https가 아니거나 자리표시면 실패시킨다.
- 개발: `CAP_ENV=dev`일 때만 `cleartext`, `allowMixedContent`, 디버깅, 선택적 `CAP_SERVER_URL`(server.url)을 켠다. 에뮬레이터 API는 `VITE_API_BASE=http://10.0.2.2:3410`.
- 릴리스 전 `check:release`가 **생성된** `android/app/src/main/assets/capacitor.config.json`과 `AndroidManifest.xml`(usesCleartextTraffic, allowBackup=false)을 검사한다. dev로 sync한 뒤에는 운영 값으로 다시 sync해야 통과한다.

## 보안 저장소 플러그인 선정 (CF-M-003)
선정: `@aparajita/capacitor-secure-storage` 8.0.1 (MIT).
- Capacitor 8 전용 릴리스(8.0.0 2026-02, 8.0.1 2026-09), peer 요구 `@capacitor/core ^8`.
- Android: Android Keystore AES-GCM 키로 암호화해 앱 전용 SharedPreferences에 저장, iOS: Keychain.
- 후보 `capacitor-secure-storage-plugin` 0.13.0(MIT, peer >=8)은 마지막 릴리스가 2026-01이라 제외.
- 주의: 이 플러그인은 `@capacitor/ios`·`@capacitor/keyboard`를 의존성(peer 성격)으로 끌어와 node_modules에는 같이 깔리지만, Android 프로젝트에는 포함되지 않는다(`cap sync android`가 인식한 플러그인은 secure-storage·app·browser 3개뿐).
- 백업: 생성된 Manifest의 `allowBackup`을 `false`로 패치(`scripts/patch-android.mjs`)하고 check-release가 강제한다.
- 웹 구현은 메모리 전용이라 새로고침하면 재로그인한다.

## 토큰 수명
revoke는 서버 세션의 local 범위만 끊는다. 이미 발급된 access token은 만료(기본 1시간)까지 유효할 수 있고, revoke 후에는 refresh가 실패한다.

## APK 배포 (스토어 없이 대시보드에서 내려받아 설치)
산출물은 저장소 루트 `mobile-dist/app.apk`·`app.json`(`{appId, version, versionCode, channel, sha256, size, builtAt}`, git 제외). 서버는 `MOBILE_APK_DIR`로 이 폴더를 읽는다.

### APK 서명 키 (1회, 저장소 밖에 보관)
```
keytool -genkeypair -v -keystore contentflow-release.jks -alias contentflow -keyalg RSA -keysize 2048 -validity 10000
```
- **키를 잃으면 이미 설치된 앱을 업데이트할 수 없다**(삭제 후 재설치 = 로컬 토큰 손실). `.jks`와 비밀번호를 비밀번호 관리자·별도 백업에 이중 보관한다. 저장소·이미지에 넣지 않는다.
- 환경변수(값은 출력되지 않는다): `ANDROID_KEYSTORE_PATH` `ANDROID_KEYSTORE_PASSWORD` `ANDROID_KEY_ALIAS` `ANDROID_KEY_PASSWORD`. Gradle `signingConfig`가 env에서만 읽는다.
- dev·release 채널 모두 서명한다(미서명 APK는 설치 불가). dev는 `ANDROID_DEV_KEYSTORE_PATH`·`ANDROID_DEV_KEYSTORE_PASSWORD`·`ANDROID_DEV_KEY_ALIAS`·`ANDROID_DEV_KEY_PASSWORD`가 있으면 그 키를, 없으면 release 키를 쓴다.
- dev 채널은 appId가 `com.devops0906.contentflow.dev`, 앱 이름이 "ContentFlow (개발)"라 정식 앱과 나란히 설치되고 서로 덮어쓰지 않는다(같은 키를 써도 마찬가지).

### 빌드 (JDK 21 + Android SDK 필요: `ANDROID_HOME` 설정)
```
CAP_ENV=release VITE_API_BASE=https://<운영 주소> node apps/mobile/scripts/build-apk.mjs
CAP_ENV=dev     VITE_API_BASE=http://<PC LAN IP>:3410 node apps/mobile/scripts/build-apk.mjs
```
순서: vite build → cap sync(+allowBackup 패치) → check-release(release만) → `gradlew assembleRelease` → `mobile-dist/`. release는 https가 아니면 중단, JDK/SDK가 없으면 안내 후 종료 코드 1. `versionCode`는 package.json version에서 계산(`major*10000+minor*100+patch`) 또는 `CF_VERSION_CODE`. 업데이트하려면 version을 올려야 한다.
이 PC에는 JDK·SDK가 없어 APK 빌드는 미검증(스크립트의 사전 점검·종료 경로만 확인).
