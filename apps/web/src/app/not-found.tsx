import Link from "next/link";
export default function NotFound() {
  return (
    <div className="panel empty-state">
      <h1>화면을 찾을 수 없어요</h1>
      <p>대시보드에서 다시 시작해보세요.</p>
      <Link href="/" className="button primary">
        대시보드로
      </Link>
    </div>
  );
}
