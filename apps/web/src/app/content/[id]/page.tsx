import { EditorScreen } from "@/components/editor";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EditorScreen id={id} />;
}
