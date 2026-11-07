/**
 * Hold'em showdowns: the best five-card hand out of seven, and who takes each
 * pot when the board and the cards still in are known. Pure functions.
 */

import type { HandState, Pot } from "./hand";

const RANK_VALUE: Record<string, number> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, T: 10, J: 11, Q: 12, K: 13, A: 14,
};

/** Categories, low to high. */
export const HAND_CATEGORIES = [
  "High card",
  "Pair",
  "Two pair",
  "Three of a kind",
  "Straight",
  "Flush",
  "Full house",
  "Four of a kind",
  "Straight flush",
] as const;

/** A hand's strength: [category, ...kickers], compared left to right. */
export type Score = number[];

export function compareScores(a: Score, b: Score): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The highest card of a straight in `values` (distinct, any order), or 0. The wheel counts as 5. */
function straightHigh(values: number[]): number {
  const set = new Set(values);
  if (set.has(14)) set.add(1);
  for (let high = 14; high >= 5; high--) {
    let ok = true;
    for (let v = high; v > high - 5; v--) if (!set.has(v)) ok = false;
    if (ok) return high;
  }
  return 0;
}

/** Score exactly five cards. */
function score5(cards: string[]): Score {
  const values = cards.map((c) => RANK_VALUE[c[0]]).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const distinct = [...new Set(values)];
  const straight = distinct.length === 5 ? straightHigh(distinct) : 0;
  if (flush && straight) return [8, straight];

  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  // Groups by size then value: [[value, count], ...]
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const byCount = groups.map((g) => g[0]);

  if (groups[0][1] === 4) return [7, ...byCount];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, ...byCount];
  if (flush) return [5, ...values];
  if (straight) return [4, straight];
  if (groups[0][1] === 3) return [3, ...byCount];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, ...byCount];
  if (groups[0][1] === 2) return [1, ...byCount];
  return [0, ...values];
}

/** The best five-card score out of five to seven cards. */
export function bestScore(cards: string[]): Score {
  if (cards.length < 5) throw new Error("A hand needs five cards.");
  let best: Score | null = null;
  const pick: string[] = [];
  const walk = (from: number) => {
    if (pick.length === 5) {
      const s = score5(pick);
      if (!best || compareScores(s, best) > 0) best = s;
      return;
    }
    for (let i = from; i <= cards.length - (5 - pick.length); i++) {
      pick.push(cards[i]);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return best!;
}

/** "Two pair", "Flush"… */
export function categoryName(s: Score): string {
  return HAND_CATEGORIES[s[0]];
}

/**
 * Who takes each pot at showdown, from the full board and the cards of the
 * seats still in. A pot gets its best eligible hand (several on a tie); a
 * pot is left empty when the board is not complete or an eligible seat's
 * cards are not known — the user picks it.
 */
export function showdownWinners(pots: Pot[], board: string[], cards: Map<number, string[]>): number[][] {
  if (board.length !== 5) return pots.map((p) => (p.eligible.length === 1 ? [...p.eligible] : []));
  const scores = new Map<number, Score>();
  for (const [seat, c] of cards) if (c.length === 2) scores.set(seat, bestScore([...c, ...board]));
  return pots.map((p) => {
    if (p.eligible.length === 1) return [...p.eligible];
    if (!p.eligible.every((s) => scores.has(s))) return [];
    let best: Score | null = null;
    let out: number[] = [];
    for (const s of p.eligible) {
      const sc = scores.get(s)!;
      const d = best ? compareScores(sc, best) : 1;
      if (d > 0) {
        best = sc;
        out = [s];
      } else if (d === 0) out.push(s);
    }
    return out;
  });
}

/** The seats still in at the end of a hand. */
export function liveSeats(state: HandState): number[] {
  return state.seats.filter((s) => !s.folded).map((s) => s.seat);
}
