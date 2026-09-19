/**
 * RNG-mode scoring. Each hand shows a roll 0–99; the combo's frequencies are
 * cut into consecutive bands in button order, and the right answer is the
 * action whose band holds the roll. Pure functions only.
 */

import type { Grade } from "./types";

/** Below this share (in %, after rescaling to 100) an action is solver noise. */
export const NOISE_CUT = 2;
/** Below this share an action is "never played": choosing it is a blunder. */
export const BLUNDER_BELOW = 0.5;

/** Rescale a vector so it sums to 100. Null when there is nothing in it. */
export function normalize(vector: number[]): number[] | null {
  const clean = vector.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return clean.map((x) => (x / total) * 100);
}

/**
 * The frequencies the bands are cut from: rescaled to 100, actions under the
 * noise cut dropped, rescaled again. Null when nothing survives (can't happen
 * for a live combo, since the largest share is ≥ 100 / n).
 */
export function playableFreqs(vector: number[]): number[] | null {
  const norm = normalize(vector);
  if (!norm) return null;
  return normalize(norm.map((x) => (x < NOISE_CUT ? 0 : x)));
}

export type Band = { start: number; end: number };

/**
 * Integer bands over 0–99: action i owns [round(cum[i-1]), round(cum[i])).
 * An action at 0 gets an empty band; the last non-empty band always ends at 100.
 */
export function bands(freqs: number[]): Band[] {
  const out: Band[] = [];
  let cum = 0;
  for (const f of freqs) {
    const start = Math.round(cum);
    cum += f;
    out.push({ start, end: Math.round(cum) });
  }
  // Floating sums can land on 99.999…; the top band must reach 100.
  for (let i = out.length - 1; i >= 0; i--) {
    if (freqs[i] > 0) {
      out[i].end = 100;
      break;
    }
  }
  return out;
}

/** Index of the action whose band holds `roll`, or -1 if none (empty vector). */
export function bandIndex(freqs: number[], roll: number): number {
  const b = bands(freqs);
  return b.findIndex(({ start, end }) => roll >= start && roll < end);
}

/** A uniform integer 0–99. */
export function rollRng(rand: () => number = Math.random): number {
  return Math.min(99, Math.floor(rand() * 100));
}

export type Scored = {
  expectedIndex: number;
  grade: Grade;
  /** Share of the chosen action (%, rescaled to 100, before the noise cut). */
  chosenFreq: number;
};

export function scoreAnswer(vector: number[], roll: number, chosenIndex: number): Scored | null {
  const norm = normalize(vector);
  const play = playableFreqs(vector);
  if (!norm || !play) return null;
  const expectedIndex = bandIndex(play, roll);
  const chosenFreq = norm[chosenIndex] ?? 0;
  let grade: Grade;
  if (chosenIndex === expectedIndex) grade = "correct";
  else if ((play[chosenIndex] ?? 0) > 0) grade = "wrong_band";
  else if (chosenFreq >= BLUNDER_BELOW) grade = "mistake";
  else grade = "blunder";
  return { expectedIndex, grade, chosenFreq };
}

/** Session score: % of hands answered with the roll's action. */
export function sessionScore(hands: number, correct: number): number | null {
  return hands > 0 ? (correct / hands) * 100 : null;
}
