import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Game Art Studio",
  description: "개인용 게임 에셋 이미지 생성기 (Codex imagegen + Claude CLI)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
