import type { Metadata } from "next";
import { ResetForm } from "@/components/reset-form";

export const metadata: Metadata = { title: "비밀번호 변경 — ContentFlow" };

export default function ResetPage() {
  return <ResetForm />;
}