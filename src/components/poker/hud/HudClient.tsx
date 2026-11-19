"use client";

import dynamic from "next/dynamic";

/**
 * The HUD page lives entirely in the browser: its state is in localStorage and
 * its data comes from PioBridge on this computer. No server render, so the
 * stored table is there on the first paint.
 */
export const HudClient = dynamic(() => import("./HudView").then((m) => m.HudView), {
  ssr: false,
  loading: () => <p className="p-5 text-sm text-muted">Loading…</p>,
});
