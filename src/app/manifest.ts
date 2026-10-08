import type { MetadataRoute } from "next";

/**
 * What makes the site installable — as a desktop app (Chrome, Edge), on
 * Android, and on an iPhone's home screen. On iOS that last step is also what
 * unlocks push notifications: Safari only delivers them to installed web apps.
 *
 * It opens on the home page, which lists every tool; the shortcuts (right-click
 * the taskbar icon, long-press on a phone) jump straight into one.
 * Colours follow `globals.css` (light theme; the dark one follows the system
 * once the page has loaded).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "aderugy.fr",
    short_name: "aderugy",
    description: "Agenda, poker, jobs and maths tools",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fbfbfa",
    theme_color: "#fbfbfa",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      { name: "Agenda", url: "/agenda" },
      { name: "Backlog", url: "/agenda/backlog" },
      { name: "Live poker", url: "/poker/live" },
      { name: "Jobs", url: "/jobs" },
      { name: "Maths", url: "/maths" },
    ],
  };
}
