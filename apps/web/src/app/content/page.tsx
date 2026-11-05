import { ContentList } from "@/components/content-list";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const params = await searchParams;
  const q = Array.isArray(params.q) ? params.q[0] : params.q;
  return <ContentList key={q ?? ""} initialQuery={q} />;
}
