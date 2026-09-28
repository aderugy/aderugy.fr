/**
 * What a combo holds on a board, in PioSOLVER's hand-category terms: its made
 * hand (straight, set, top pair, underpair, king high…) and its draw (flush
 * draw, 8-out straight draw…). Both describe what the hole cards add: a pair
 * on the board doesn't make every hand "two pair". Pure functions only.
 */

import { RANKS, cardRank, cardSuit, comboCards } from "./cards";

export type MadeClass =
  | "straight_flush"
  | "quads"
  | "full_house"
  | "flush"
  | "straight"
  | "set"
  | "trips"
  | "two_pair"
  | "overpair"
  | "top_pair"
  | "pp_below_top"
  | "2nd_pair"
  | "pp_below_2nd"
  | "3rd_pair"
  | "low_pair"
  | "underpair"
  | "ace_high"
  | "king_high"
  | "nothing";

export type DrawClass = "combo_draw" | "flush_draw" | "oesd" | "gutshot" | "backdoor_fd" | "no_draw";

/** Strongest first, the order the lists are shown in. */
export const MADE_CLASSES: MadeClass[] = [
  "straight_flush",
  "quads",
  "full_house",
  "flush",
  "straight",
  "set",
  "trips",
  "two_pair",
  "overpair",
  "top_pair",
  "pp_below_top",
  "2nd_pair",
  "pp_below_2nd",
  "3rd_pair",
  "low_pair",
  "underpair",
  "ace_high",
  "king_high",
  "nothing",
];

export const DRAW_CLASSES: DrawClass[] = ["combo_draw", "flush_draw", "oesd", "gutshot", "backdoor_fd", "no_draw"];

export const MADE_LABELS: Record<MadeClass, string> = {
  straight_flush: "Straight flush",
  quads: "Quads",
  full_house: "Full house",
  flush: "Flush",
  straight: "Straight",
  set: "Set",
  trips: "Trips",
  two_pair: "Two pair",
  overpair: "Overpair",
  top_pair: "Top pair",
  pp_below_top: "PP below top pair",
  "2nd_pair": "2nd pair",
  pp_below_2nd: "PP below 2nd pair",
  "3rd_pair": "3rd pair",
  low_pair: "Low pair",
  underpair: "Underpair",
  ace_high: "Ace high",
  king_high: "King high",
  nothing: "Nothing",
};

export const DRAW_LABELS: Record<DrawClass, string> = {
  combo_draw: "Combo draw",
  flush_draw: "Flush draw",
  oesd: "8-out straight draw",
  gutshot: "4-out straight draw",
  backdoor_fd: "Backdoor flush draw",
  no_draw: "No draw",
};

/* ------------------------------------------------------------ evaluation */

/** 2 → 2 … A → 14. */
function value(rank: string): number {
  return 14 - RANKS.indexOf(rank as (typeof RANKS)[number]);
}

/** Highest straight in a set of rank values (the wheel counts), 0 if none. */
function straightHigh(values: Set<number>): number {
  const has = (v: number) => values.has(v) || (v === 1 && values.has(14));
  for (let hi = 14; hi >= 5; hi--) {
    let ok = true;
    for (let v = hi; v > hi - 5; v--) if (!has(v)) ok = false;
    if (ok) return hi;
  }
  return 0;
}

type Category = 8 | 7 | 6 | 5 | 4 | 3 | 2 | 1 | 0; // SF, quads, FH, flush, straight, trips, two pair, pair, high

/**
 * The best five-card hand among the cards, as a comparable number: the
 * category in the top digits, then the ranks that break ties.
 */
export function handStrength(cards: string[]): number {
  const counts = new Map<number, number>();
  const bySuit = new Map<string, number[]>();
  for (const c of cards) {
    const v = value(cardRank(c));
    counts.set(v, (counts.get(v) ?? 0) + 1);
    const s = cardSuit(c);
    bySuit.set(s, [...(bySuit.get(s) ?? []), v]);
  }
  const score = (cat: Category, kick: number[]) => kick.slice(0, 5).reduce((acc, k, i) => acc + k * 15 ** (4 - i), cat * 15 ** 5);

  let flushVals: number[] | null = null;
  for (const vs of bySuit.values()) if (vs.length >= 5) flushVals = [...vs].sort((a, b) => b - a);
  if (flushVals) {
    const sf = straightHigh(new Set(flushVals));
    if (sf) return score(8, [sf]);
  }
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const singles = (skip: number[]) => [...counts.keys()].filter((v) => !skip.includes(v)).sort((a, b) => b - a);
  if (groups[0][1] >= 4) return score(7, [groups[0][0], ...singles([groups[0][0]]).slice(0, 1)]);
  if (groups[0][1] === 3 && groups.length > 1 && groups[1][1] >= 2) return score(6, [groups[0][0], groups[1][0]]);
  if (flushVals) return score(5, flushVals);
  const st = straightHigh(new Set(counts.keys()));
  if (st) return score(4, [st]);
  if (groups[0][1] === 3) return score(3, [groups[0][0], ...singles([groups[0][0]]).slice(0, 2)]);
  if (groups[0][1] === 2 && groups.length > 1 && groups[1][1] === 2) {
    return score(2, [groups[0][0], groups[1][0], ...singles([groups[0][0], groups[1][0]]).slice(0, 1)]);
  }
  if (groups[0][1] === 2) return score(1, [groups[0][0], ...singles([groups[0][0]]).slice(0, 3)]);
  return score(0, singles([]));
}

function category(strength: number): Category {
  return Math.floor(strength / 15 ** 5) as Category;
}

/* ---------------------------------------------------------- classification */

/** The combo's made hand on this board (3 to 5 cards). */
export function madeClass(combo: string, board: string[]): MadeClass {
  const hole = comboCards(combo);
  const cards = [...hole, ...board];
  const mine = handStrength(cards);
  const cat = category(mine);
  // Straights and better only count when the hole cards play.
  const playsBig = board.length < 5 || mine > handStrength(board);
  if (playsBig && cat >= 4) {
    return (["straight", "flush", "full_house", "quads", "straight_flush"] as const)[cat - 4];
  }

  const boardVals = board.map((c) => value(cardRank(c)));
  const distinct = [...new Set(boardVals)].sort((a, b) => b - a);
  const boardCount = (v: number) => boardVals.filter((x) => x === v).length;
  const [h1, h2] = hole.map((c) => value(cardRank(c)));

  if (h1 === h2) {
    if (boardCount(h1) >= 1) return "set";
    if (h1 > distinct[0]) return "overpair";
    if (distinct.length > 1 && h1 > distinct[1]) return "pp_below_top";
    if (distinct.length > 2 && h1 > distinct[2]) return "pp_below_2nd";
    return "underpair";
  }
  const hits = [h1, h2].filter((v) => boardCount(v) >= 1);
  if (hits.some((v) => boardCount(v) >= 2)) return "trips";
  if (hits.length === 2) return "two_pair";
  if (hits.length === 1) {
    const at = distinct.indexOf(hits[0]);
    return at === 0 ? "top_pair" : at === 1 ? "2nd_pair" : at === 2 ? "3rd_pair" : "low_pair";
  }
  const hi = Math.max(h1, h2);
  return hi === 14 ? "ace_high" : hi === 13 ? "king_high" : "nothing";
}

/** The combo's draw on this board; always "no_draw" on the river. */
export function drawClass(combo: string, board: string[]): DrawClass {
  if (board.length >= 5) return "no_draw";
  const hole = comboCards(combo);
  const cards = [...hole, ...board];

  // Flush draw: four of a suit with a hole card in it (no flush made yet).
  const suitCount = (s: string) => cards.filter((c) => cardSuit(c) === s).length;
  const holeSuits = new Set(hole.map(cardSuit));
  const flushMade = [...holeSuits].some((s) => suitCount(s) >= 5);
  const fd = !flushMade && [...holeSuits].some((s) => suitCount(s) === 4);
  const bdfd = !fd && !flushMade && board.length === 3 && [...holeSuits].some((s) => suitCount(s) === 3);

  // Straight draw: ranks that would complete a straight the hole cards play in.
  const vals = new Set(cards.map((c) => value(cardRank(c))));
  const boardVals = new Set(board.map((c) => value(cardRank(c))));
  let outs = 0;
  if (!straightHigh(vals)) {
    for (let v = 2; v <= 14; v++) {
      if (vals.has(v)) continue;
      const withV = new Set(vals).add(v);
      const mine = straightHigh(withV);
      if (mine && mine > straightHigh(new Set(boardVals).add(v))) outs++;
    }
  }
  const sd = outs >= 2 ? "oesd" : outs === 1 ? "gutshot" : null;

  if (fd && sd) return "combo_draw";
  if (fd) return "flush_draw";
  if (sd) return sd;
  if (bdfd) return "backdoor_fd";
  return "no_draw";
}
