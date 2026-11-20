import type { HudGroup, HudItem, HudPos } from "./types";

/**
 * Panels of our own, beside the ones exported from PT4. Their stats must be
 * in the bridge's catalogue (tools/pio-bridge/internal/pt4/stats.go).
 */

const COLS: [string, HudPos][] = [
  ["Total", 0],
  ["EP", 3],
  ["MP", 4],
  ["CO", 5],
  ["BTN", 6],
  ["SB", 2],
  ["BB", 1],
];

function row(label: string, stat: string): HudItem[] {
  return [{ t: "text", text: label }, ...COLS.map(([, pos]): HudItem => ({ t: "stat", stat, pos })), { t: "br" }];
}

/** Play against limpers, by position (a popup tab): isolation raises, overlimps, 3bets against an iso. */
export const LIMPERS: HudGroup = {
  name: "Limpers",
  main: false,
  items: [
    { t: "text", text: "Limpers" },
    ...COLS.map(([name]): HudItem => ({ t: "text", text: name, align: "center" })),
    { t: "br" },
    { t: "hr" },
    ...row("Iso", "Raise With Previous Limpers"),
    ...row("Overlimp", "Limp With Previous Limpers"),
    ...row("3B vs iso", "3Bet vs Iso-Raise"),
  ],
};
