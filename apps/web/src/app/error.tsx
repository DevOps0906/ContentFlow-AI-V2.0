"use client";
export default function Error({ reset }: { reset: () => void }) {
  return (
    <div role="alert" className="panel empty-state">
      <h1>화면을 불러오지 못했어요</h1>
      <p>저장된 콘텐츠는 설정 화면에서 백업할 수 있습니다.</p>
      <button className="button primary" onClick={reset}>
        다시 시도
      </button>
    </div>
  );
}
