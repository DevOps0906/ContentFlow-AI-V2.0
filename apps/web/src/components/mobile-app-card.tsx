"use client";
import { useEffect, useState } from "react";
import { Download, Smartphone } from "lucide-react";

type AppState =
  | { available: false; invalid?: boolean }
  | { available: true; version: string; versionCode: number; channel: "dev" | "release"; sha256: string; size: number; builtAt: string };

function formatSize(bytes: number) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Dashboard card: the Android APK served by this app (account mode only). */
export function MobileAppCard() {
  const [app, setApp] = useState<AppState | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/mobile/app", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("fail"))))
      .then((j) => !cancelled && setApp(j))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="panel mobile-app-card" aria-labelledby="mobile-app-title">
      <div className="section-heading">
        <h2 id="mobile-app-title">
          <Smartphone size={16} />
          모바일 앱
        </h2>
        {app?.available && app.channel === "dev" ? <span className="mobile-app-badge">개발용</span> : null}
      </div>
      {failed ? (
        <p className="mobile-app-note">앱 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.</p>
      ) : !app ? (
        <p className="mobile-app-note" role="status">불러오는 중…</p>
      ) : app.available ? (
        <>
          <dl className="mobile-app-meta">
            <div><dt>버전</dt><dd>{app.version} ({app.versionCode})</dd></div>
            <div><dt>크기</dt><dd>{formatSize(app.size)}</dd></div>
            <div><dt>빌드</dt><dd>{app.builtAt.slice(0, 10)}</dd></div>
            <div className="wide"><dt>SHA-256</dt><dd className="mobile-app-hash">{app.sha256}</dd></div>
          </dl>
          <a className="button primary" href="/api/mobile/app/download" download>
            <Download size={16} />
            Android 앱 내려받기
          </a>
          <ol className="mobile-app-steps">
            <li>휴대폰 브라우저에서 이 화면을 열어 내려받습니다.</li>
            <li>설치할 때 “출처를 알 수 없는 앱 설치”를 허용합니다.</li>
            <li>업데이트는 같은 서명 키로 만든 새 버전만 덮어쓸 수 있습니다.</li>
          </ol>
        </>
      ) : app.invalid ? (
        <p className="mobile-app-note">배포 파일 검증에 실패해 내려받을 수 없습니다. 관리자에게 문의하세요.</p>
      ) : (
        <p className="mobile-app-note">아직 배포된 앱 없음</p>
      )}
      <p className="mobile-app-note">iOS: 미지원</p>
    </section>
  );
}
