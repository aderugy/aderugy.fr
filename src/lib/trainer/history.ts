/**
 * Aggregates for the History tab, computed from stored answers (their own
 * snapshots, so an edited strategy never rewrites the past). Pure functions.
 */

import { comboToHand, handShape } from "../solver/cards";
import { playableFreqs } from "./score";
import type { TrainerAnswer } from "./types";

export type Tally = { key: string; label: string; hands: number; correct: number; blunders: number };

function tally(map: Map<string, Tally>, key: string, label: string, a: TrainerAnswer) {
  const t = map.get(key) ?? { key, label, hands: 0, correct: 0, blunders: 0 };
  t.hands++;
  if (a.grade === "correct") t.correct++;
  if (a.grade === "blunder") t.blunders++;
  map.set(key, t);
}

const accuracy = (t: Tally) => t.correct / t.hands;

/** Worst first, only rows with enough hands to mean something. */
function worst(map: Map<string, Tally>, minHands: number): Tally[] {
  return [...map.values()]
    .filter((t) => t.hands >= minHands)
    .sort((a, b) => accuracy(a) - accuracy(b) || b.hands - a.hands);
}

const BROADWAY = new Set(["A", "K", "Q", "J", "T"]);

/** A coarse hand class, enough to spot a leak ("suited connectors", "offsuit broadways"…). */
export function handClass(combo: string): string {
  const hand = comboToHand(combo);
  const shape = handShape(hand);
  if (shape === "pair") return BROADWAY.has(hand[0]) ? "Big pairs" : "Small & mid pairs";
  const s = shape === "suited" ? "Suited" : "Offsuit";
  const [a, b] = [hand[0], hand[1]];
  if (BROADWAY.has(a) && BROADWAY.has(b)) return `${s} broadways`;
  if (a === "A") return `${s} aces`;
  const order = "AKQJT98765432";
  const gap = order.indexOf(b) - order.indexOf(a);
  if (gap <= 2) return `${s} connectors`;
  return `${s} others`;
}

export function byNode(answers: TrainerAnswer[], labelOf: (nodeId: string) => string, minHands = 5): Tally[] {
  const m = new Map<string, Tally>();
  for (const a of answers) if (a.node_id) tally(m, a.node_id, labelOf(a.node_id), a);
  return worst(m, minHands);
}

export function byHandClass(answers: TrainerAnswer[], minHands = 5): Tally[] {
  const m = new Map<string, Tally>();
  for (const a of answers) {
    const c = handClass(a.combo);
    tally(m, c, c, a);
  }
  return worst(m, minHands);
}

/** Most common swaps on wrong answers: "Call instead of Fold". */
export function confusions(answers: TrainerAnswer[], limit = 5): { label: string; count: number }[] {
  const m = new Map<string, number>();
  for (const a of answers) {
    if (a.grade === "correct") continue;
    const chosen = a.actions.find((x) => x.id === a.chosen_action_id)?.label ?? "?";
    const expected = a.actions.find((x) => x.id === a.expected_action_id)?.label ?? "?";
    const key = `${chosen} instead of ${expected}`;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * Mix discipline, per action label, over mixed combos only (two or more
 * playable actions): how often it was chosen vs how often the solver plays it.
 * Chosen share near the solver share means the RNG is being followed.
 */
export function mixDiscipline(answers: TrainerAnswer[]): { label: string; solver: number; chosen: number; hands: number }[] {
  const m = new Map<string, { solver: number; chosen: number; hands: number }>();
  let mixed = 0;
  for (const a of answers) {
    const play = playableFreqs(a.freqs.map(Number));
    if (!play || play.filter((f) => f > 0).length < 2) continue;
    mixed++;
    a.actions.forEach((act, i) => {
      const row = m.get(act.label) ?? { solver: 0, chosen: 0, hands: 0 };
      row.solver += play[i] ?? 0;
      row.chosen += act.id === a.chosen_action_id ? 100 : 0;
      row.hands++;
      m.set(act.label, row);
    });
  }
  if (mixed === 0) return [];
  return [...m.entries()]
    .map(([label, r]) => ({ label, solver: r.solver / r.hands, chosen: r.chosen / r.hands, hands: r.hands }))
    .sort((a, b) => b.solver - a.solver);
}
