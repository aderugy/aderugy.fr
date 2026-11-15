"use client";

import { useEffect } from "react";

const LAUNCHED = "launched";

/**
 * The installed app opens on the home page. Its manifest says so (`start_url:
 * "/"`), but an install made while the manifest still said `/agenda` keeps
 * that address — iOS never re-reads a home-screen app's manifest. So a cold
 * launch of the app that lands on a bare `/agenda` is sent home.
 *
 * Only a launch: in standalone mode, the first page of the app's run (the
 * flag lives in sessionStorage, which a fresh launch starts empty), reached
 * with no referrer and not by a reload. The ways in that do mean the agenda
 * carry a query and are left alone: the "Agenda" shortcut
 * (`/agenda?from=shortcut`) and a reminder tapped while the app is closed
 * (`?from=notification`, added by sw.js).
 */
export function LaunchHome() {
  useEffect(() => {
    let first = false;
    try {
      first = !sessionStorage.getItem(LAUNCHED);
      sessionStorage.setItem(LAUNCHED, "1");
    } catch {
      return;
    }
    if (!first) return;
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (!standalone) return;
    if (location.pathname !== "/agenda" || location.search || location.hash) return;
    if (document.referrer) return;
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.type !== "navigate") return;
    location.replace("/");
  }, []);
  return null;
}
