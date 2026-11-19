import { HudClient } from "@/components/poker/hud/HudClient";

export const metadata = { title: "HUD — Poker" };

/**
 * PokerTracker 4 HUDs of the players at the table. Everything comes from the
 * local PT4 database through PioBridge, in the browser: the server only
 * renders the shell.
 */
export default function HudPage() {
  return <HudClient />;
}
