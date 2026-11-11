# 모바일 앱(Android APK) 배포 — 대시보드 다운로드

스토어 대신 대시보드 "모바일 앱" 카드에서 APK를 내려받아 설치한다(사이드로드). iOS는 미지원.

## 절차
1. 빌드: `apps/mobile/scripts/build-apk.mjs`(JDK 21 + Android SDK 필요). 서명 키는 저장소 밖에 보관하고 백업한다. 키를 잃으면 기존 설치본을 업데이트할 수 없다.
2. 배치: 결과물 `app.apk`와 `app.json`을 저장소 루트 `mobile-dist/`에 둔다(git 제외). compose가 `./mobile-dist`를 컨테이너 `/app/mobile-dist`에 읽기 전용으로 마운트하고 `MOBILE_APK_DIR=/app/mobile-dist`를 설정한다. 폴더가 비어 있어도 앱은 기동하고 카드는 "아직 배포된 앱 없음"을 보인다.
3. 다운로드: 로그인한 뒤 대시보드 카드의 버튼(`GET /api/mobile/app/download`). 휴대폰 브라우저에서 직접 받아 "출처를 알 수 없는 앱 설치"를 허용하고 설치한다.

## app.json
```json
{ "version": "0.1.0", "versionCode": 1, "channel": "dev", "sha256": "<app.apk의 SHA-256 소문자 64자>", "builtAt": "2026-11-12T00:00:00Z" }
```
- `channel`: `dev`(카드에 "개발용" 배지) 또는 `release`.
- 서버는 실제 파일 해시와 `sha256`이 다르면 다운로드를 503으로 막는다. 파일 경로는 `MOBILE_APK_DIR/app.apk` 고정이며 요청 값으로 만들지 않는다.
- API는 쿠키 로그인 전용이다(Bearer·미로그인 거부).

## Bearer 세션(모바일 앱) 운영 가정
- 토큰 발급·갱신 IP 제한은 `TRUST_PROXY=true`일 때만 `x-forwarded-for` 가장 오른쪽 hop(없으면 `x-real-ip`)을 쓴다. 이 값은 앱 앞의 리버스 프록시가 클라이언트 주소를 덧붙이고 외부에서 온 헤더를 신뢰하지 않는다는 가정이 맞을 때만 켠다. 꺼져 있으면 모든 호출자가 `direct` 버킷(token 60/분, refresh 120/분)을 공유하고, 이메일 기준 제한(8/분)은 그대로 적용된다.
- Bearer는 워크스페이스를 만들지 않는다(없으면 409). `X-Workspace-Id`가 멤버가 아니면 403이며 쿠키로 대체하지 않는다.
- revoke 뒤에도 access token은 만료(기본 1시간)까지 유효할 수 있다. refresh는 즉시 실패한다.
