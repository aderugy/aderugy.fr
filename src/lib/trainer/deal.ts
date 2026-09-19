/**
 * Dealing a hand: a node by its weight, then a combo in proportion to how much
 * of it is in range. Pure functions; randomness is injected so tests can seed.
 */

import { GRID_HANDS, comboBlocked, handCombos } from "../solver/cards";
import { comboVector, vectorTotal } from "../solver/strategy";
import type { StrategyWeights } from "../solver/types";

export type ComboEntry = { combo: string; hand: string; vector: number[]; weight: number };

/**
 * Every live combo with something in range. A combo whose vector sums to 40
 * is 0.4 of a full combo, so it is dealt 0.4× as often.
 */
export function comboPool(weights: StrategyWeights, len: number, dead: Set<string>): ComboEntry[] {
  const out: ComboEntry[] = [];
  for (const hand of GRID_HANDS) {
    for (const combo of handCombos(hand)) {
      if (comboBlocked(combo, dead)) continue;
      const vector = comboVector(weights, combo, hand, len);
      const total = vectorTotal(vector);
      if (total <= 0) continue;
      out.push({ combo, hand, vector, weight: Math.min(total, 100) / 100 });
    }
  }
  return out;
}

/** Pick one item with probability proportional to `weightOf`. Null when all weigh 0. */
export function pickWeighted<T>(
  items: T[],
  weightOf: (item: T) => number,
  rand: () => number = Math.random,
): T | null {
  let total = 0;
  for (const item of items) total += Math.max(0, weightOf(item));
  if (total <= 0) return null;
  let r = rand() * total;
  for (const item of items) {
    const w = Math.max(0, weightOf(item));
    if (w <= 0) continue;
    if (r < w) return item;
    r -= w;
  }
  // Floating-point tail: fall back to the last item that has weight.
  for (let i = items.length - 1; i >= 0; i--) if (weightOf(items[i]) > 0) return items[i];
  return null;
}
