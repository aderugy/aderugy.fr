/**
 * Reading and editing a strategy node's per-hand action distribution.
 *
 * Weights are percentages (0–100) in a vector aligned to the node's action
 * order. `combos` overrides `hands` for exact combos, so a cell can carry
 * per-combo detail on top of a hand-level default. Pure functions only.
 */

import { GRID_HANDS, comboBlocked, handCombos } from "./cards";
import type { StrategyWeights } from "./types";

/** A zeroed vector of the given length. */
export function zeroVector(len: number): number[] {
  return new Array<number>(len).fill(0);
}

/** A pure-action vector: 100% on `index`, 0 elsewhere. */
export function pureVector(len: number, index: number): number[] {
  const v = zeroVector(len);
  if (index >= 0 && index < len) v[index] = 100;
  return v;
}

function fit(vector: number[] | undefined, len: number): number[] | null {
  if (!vector) return null;
  const v = zeroVector(len);
  for (let i = 0; i < len; i++) v[i] = Number(vector[i]) || 0;
  return v;
}

/**
 * The distribution to display for a hand cell.
 *
 * If any of the hand's combos carries an override the cell shows the average
 * across all its combos (each combo falling back to the hand vector, then to
 * zero). Otherwise it is the hand-level vector, or null when nothing is set.
 */
export function handDisplayVector(
  weights: StrategyWeights,
  hand: string,
  len: number,
): number[] | null {
  const combos = handCombos(hand);
  const hasOverride = combos.some((c) => weights.combos[c]);
  const handVec = fit(weights.hands[hand], len);

  if (!hasOverride) return handVec;

  const sum = zeroVector(len);
  for (const combo of combos) {
    const vec = fit(weights.combos[combo], len) ?? handVec ?? zeroVector(len);
    for (let i = 0; i < len; i++) sum[i] += vec[i];
  }
  return sum.map((x) => x / combos.length);
}

/** The vector for one exact combo: its override, else the hand default. */
export function comboVector(
  weights: StrategyWeights,
  combo: string,
  hand: string,
  len: number,
): number[] {
  return (
    fit(weights.combos[combo], len) ??
    fit(weights.hands[hand], len) ??
    zeroVector(len)
  );
}

/** Set a hand-level vector and drop any per-combo overrides for that hand. */
export function paintHand(
  weights: StrategyWeights,
  hand: string,
  vector: number[],
): StrategyWeights {
  const hands = { ...weights.hands, [hand]: [...vector] };
  const combos = { ...weights.combos };
  for (const c of handCombos(hand)) delete combos[c];
  return { hands, combos };
}

/** Set (or clear) a single combo override. */
export function paintCombo(
  weights: StrategyWeights,
  combo: string,
  vector: number[] | null,
): StrategyWeights {
  const combos = { ...weights.combos };
  if (vector) combos[combo] = [...vector];
  else delete combos[combo];
  return { hands: { ...weights.hands }, combos };
}

/** Total across a vector; used to render the "unassigned" remainder. */
export function vectorTotal(vector: number[]): number {
  return vector.reduce((a, b) => a + (Number(b) || 0), 0);
}

/**
 * When a strategy's action list changes length (an action added or removed at
 * `removedIndex`), remap every stored vector so it stays aligned.
 */
export function remapWeights(
  weights: StrategyWeights,
  oldLen: number,
  newLen: number,
  removedIndex: number | null,
): StrategyWeights {
  const remap = (vec: number[]): number[] => {
    const fitted = fit(vec, oldLen) ?? zeroVector(oldLen);
    if (removedIndex === null) return [...fitted, ...zeroVector(newLen - oldLen)];
    return fitted.filter((_, i) => i !== removedIndex);
  };
  const mapAll = (rec: Record<string, number[]>) =>
    Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, remap(v)]));
  return { hands: mapAll(weights.hands), combos: mapAll(weights.combos) };
}

/**
 * How often each action is taken across the whole range, in percent — the
 * solver's "global strategy". Every live combo (not blocked by the board)
 * counts in proportion to how much of it is in range (its vector's total, so a
 * combo at 40% total weighs 0.4 of a full one). Null when nothing is set.
 */
export function globalFrequencies(
  weights: StrategyWeights,
  len: number,
  dead: Set<string>,
): number[] | null {
  const sum = zeroVector(len);
  let weight = 0;
  for (const hand of GRID_HANDS) {
    const handVec = fit(weights.hands[hand], len);
    for (const combo of handCombos(hand)) {
      if (comboBlocked(combo, dead)) continue;
      const vec = fit(weights.combos[combo], len) ?? handVec;
      if (!vec) continue;
      const total = vectorTotal(vec);
      if (total <= 0) continue;
      for (let i = 0; i < len; i++) sum[i] += vec[i];
      weight += total;
    }
  }
  return weight > 0 ? sum.map((x) => (x / weight) * 100) : null;
}
