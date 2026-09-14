import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "aderugy.fr",
  description: "Personal site and utility tools",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
