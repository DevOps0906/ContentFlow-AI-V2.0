import type { Metadata } from "next";
import { Shell } from "@/components/shell";
import { WorkspaceProvider } from "@/components/workspace";
import "./globals.css";
export const metadata: Metadata = {
  title: "ContentFlow — 나의 블로그 스튜디오",
  description: "템플릿으로 시작하고 근거로 완성하는 블로그 콘텐츠 작업 공간",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>
        <a className="skip-link" href="#main-content">
          본문으로 바로가기
        </a>
        <WorkspaceProvider>
          <Shell>{children}</Shell>
        </WorkspaceProvider>
      </body>
    </html>
  );
}
