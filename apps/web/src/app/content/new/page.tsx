import { EditorScreen } from "@/components/editor";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ template?: string | string[] }>;
}) {
  const params = await searchParams;
  const template = Array.isArray(params.template)
    ? params.template[0]
    : params.template;
  return <EditorScreen templateId={template} />;
}
