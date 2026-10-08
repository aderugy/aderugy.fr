import type { Metadata, Viewport } from "next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/next";
import { ServiceWorker } from "@/components/ServiceWorker";
import "./globals.css";

export const metadata: Metadata = {
  title: "aderugy.fr",
  description: "Personal site and utility tools",
  // iOS reads these rather than the manifest for the home-screen app's name
  // and status bar. The icon is `app/apple-icon.png`.
  appleWebApp: {
    capable: true,
    title: "aderugy",
    statusBarStyle: "default",
  },
};

// The installed app's title bar (desktop) and status bar (Android) take this
// colour, so it matches the page background in each theme.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfa" },
    { media: "(prefers-color-scheme: dark)", color: "#111110" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {children}
        <ServiceWorker />
        <SpeedInsights />
        <Analytics />
      </body>
    </html>
  );
}
