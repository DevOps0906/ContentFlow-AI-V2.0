import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = { title: "로그인 — ContentFlow" };

export default function LoginPage() {
  return <LoginForm />;
}