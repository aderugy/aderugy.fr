/**
 * Action colours for strategies, matching the solver palette: fold is always
 * blue, check/call always green, and bets/raises run along a red ramp where
 * the bigger the sizing, the darker the colour. Pure functions only.
 */

import type { ActionKind, StrategyAction } from "./types";

export const FOLD_COLOR = "#6da2c0";
export const PASSIVE_COLOR = "#8fbc8b"; // check / call

/** Bet ramp, largest (darkest) → smallest (lightest). */
export const BET_RAMP = ["#a95041", "#c16d59", "#d6846b", "#e9967a"];

/** Swatches offered by the manual colour pickers. */
export const ACTION_SWATCHES = [...BET_RAMP, PASSIVE_COLOR, FOLD_COLOR];

function isAggressive(kind: ActionKind): boolean {
  return kind === "bet" || kind === "raise";
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: number[]): string {
  return `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;
}

/** Colour at t ∈ [0, 1] along the ramp (0 = darkest, 1 = lightest). */
function rampAt(t: number): string {
  const pos = Math.min(1, Math.max(0, t)) * (BET_RAMP.length - 1);
  const i = Math.min(BET_RAMP.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = hexToRgb(BET_RAMP[i]);
  const b = hexToRgb(BET_RAMP[i + 1]);
  return rgbToHex(a.map((x, k) => x + (b[k] - x) * f));
}

/** Sort key for sizing: all-in (no size, labelled as such) is the biggest. */
function sizeKey(a: Pick<StrategyAction, "sizePct" | "label">): number {
  if (a.sizePct != null) return a.sizePct;
  return /all.?in|jam|shove/i.test(a.label) ? Number.POSITIVE_INFINITY : 0;
}

/**
 * The palette colour for each action in the set. Bets are ranked by size
 * across the whole set, so four sizes map exactly onto the four ramp stops
 * and any other count is interpolated along it.
 */
export function actionColors(
  actions: Pick<StrategyAction, "kind" | "sizePct" | "label">[],
): string[] {
  const bets = actions
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => isAggressive(a.kind))
    .sort((x, y) => sizeKey(y.a) - sizeKey(x.a));

  const out: string[] = actions.map((a) =>
    a.kind === "fold" ? FOLD_COLOR : isAggressive(a.kind) ? "" : PASSIVE_COLOR,
  );
  bets.forEach(({ i }, rank) => {
    // A lone bet sits mid-ramp; otherwise spread from darkest to lightest.
    const t = bets.length === 1 ? 2 / 3 : rank / (bets.length - 1);
    out[i] = rampAt(t);
  });
  return out;
}

/** Re-apply the palette to a whole action set. */
export function recolorActions<T extends StrategyAction>(actions: T[]): T[] {
  const colors = actionColors(actions);
  return actions.map((a, i) => (a.color === colors[i] ? a : { ...a, color: colors[i] }));
}

/** Colour for a single, stand-alone action (no sibling sizes to rank against). */
export function colorForKind(kind: ActionKind): string {
  if (kind === "fold") return FOLD_COLOR;
  if (isAggressive(kind)) return rampAt(2 / 3);
  return PASSIVE_COLOR;
}
