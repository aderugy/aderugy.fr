/**
 * Hand categories on a decision: the user splits the range into named,
 * coloured groups (nuts, strong draws, air…) to learn the strategy by group.
 * A combo is in at most one category; combos in none are "Other". Also the
 * ready-made groups used to pick combos fast (hand classes, equity and EV
 * buckets) and the strategy of any group. Pure functions only.
 */

import { GRID_HANDS, RANKS, cardRank, cardSuit, comboBlocked, comboCards, handCombos, type Suit } from "./cards";
import { comboVector, vectorTotal } from "./strategy";
import { DRAW_CLASSES, DRAW_LABELS, MADE_CLASSES, MADE_LABELS, drawClass, madeClass } from "./handClass";
import type { StrategyStats, StrategyWeights } from "./types";

export type HandCategory = {
  id: string;
  name: string;
  color: string;
  /** Exact combos ("AhKs"). */
  combos: string[];
};

/** Colours offered for a new category, in order. */
export const CATEGORY_COLORS = [
  "#16a34a",
  "#2563eb",
  "#f59e0b",
  "#dc2626",
  "#9333ea",
  "#0891b2",
  "#db2777",
  "#65a30d",
  "#78716c",
  "#1e293b",
];

export function asCategories(raw: unknown): HandCategory[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is HandCategory => !!c && typeof c.id === "string" && typeof c.name === "string")
    .map((c) => ({
      id: c.id,
      name: c.name,
      color: typeof c.color === "string" ? c.color : CATEGORY_COLORS[0],
      combos: Array.isArray(c.combos) ? c.combos.filter((x): x is string => typeof x === "string") : [],
    }));
}

/** Put combos in a category (null = back to Other), out of any other one. */
export function assignCombos(cats: HandCategory[], combos: Iterable<string>, target: string | null): HandCategory[] {
  const moving = new Set(combos);
  return cats.map((c) => {
    const kept = c.combos.filter((x) => !moving.has(x));
    return { ...c, combos: c.id === target ? [...kept, ...moving] : kept };
  });
}

/** Category id by combo. */
export function categoryIndex(cats: HandCategory[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of cats) for (const x of c.combos) out.set(x, c.id);
  return out;
}

/* ---------------------------------------------------------------- range */

/** A live combo of the range: how much of it is in range (0–1) and its strategy (%, sums to 100). */
export type RangeCombo = { combo: string; hand: string; reach: number; strategy: number[] };

/** Every combo in range at a decision, from its grid. */
export function rangeCombos(weights: StrategyWeights, len: number, dead: Set<string>): RangeCombo[] {
  const out: RangeCombo[] = [];
  for (const hand of GRID_HANDS) {
    for (const combo of handCombos(hand)) {
      if (comboBlocked(combo, dead)) continue;
      const v = comboVector(weights, combo, hand, len);
      const total = vectorTotal(v);
      if (total <= 0) continue;
      out.push({ combo, hand, reach: Math.min(1, total / 100), strategy: v.map((x) => (x / total) * 100) });
    }
  }
  return out;
}

/** A group of combos summed up: share of the range, strategy, averages. */
export type GroupSummary = {
  combos: number;
  /** Range weight, in combos (a combo half in range counts 0.5). */
  weight: number;
  /** % of the whole range. */
  share: number;
  /** How often each option is taken, % (null when empty). */
  strategy: number[] | null;
  /** The acting player's average equity (%) and EV (bb), when imported. */
  equity: number | null;
  ev: number | null;
};

export function summarize(
  range: RangeCombo[],
  inGroup: (c: RangeCombo) => boolean,
  len: number,
  stats: StrategyStats | null,
): GroupSummary {
  const total = range.reduce((a, c) => a + c.reach, 0);
  const sum = new Array<number>(len).fill(0);
  let weight = 0;
  let combos = 0;
  let eq = 0;
  let eqW = 0;
  let ev = 0;
  let evW = 0;
  const actor = stats?.players[stats.actor];
  for (const c of range) {
    if (!inGroup(c)) continue;
    combos++;
    weight += c.reach;
    for (let i = 0; i < len; i++) sum[i] += (c.strategy[i] ?? 0) * c.reach;
    const e = actor?.equity[c.combo];
    if (e != null) {
      eq += e * c.reach;
      eqW += c.reach;
    }
    const v = stats?.ev?.node[c.combo];
    if (v != null) {
      ev += v * c.reach;
      evW += c.reach;
    }
  }
  return {
    combos,
    weight,
    share: total > 0 ? (weight / total) * 100 : 0,
    strategy: weight > 0 ? sum.map((x) => x / weight) : null,
    equity: eqW > 0 ? eq / eqW : null,
    ev: evW > 0 ? ev / evW : null,
  };
}

/* ------------------------------------------------------- ready-made groups */

export type QuickGroup = { id: string; label: string; test: (c: RangeCombo) => boolean };
export type QuickSection = { id: string; label: string; groups: QuickGroup[] };

/**
 * The groups offered to pick combos: made hands and draws (from the board),
 * the actor's equity and EV (as % of the pot) when the decision was imported
 * from the solver. Empty groups are dropped.
 */
export function quickSections(
  range: RangeCombo[],
  board: string[],
  stats: StrategyStats | null,
  potBb: number | null,
): QuickSection[] {
  const sections: QuickSection[] = [];
  if (board.length >= 3) {
    const made = new Map(range.map((c) => [c.combo, madeClass(c.combo, board)]));
    const draw = new Map(range.map((c) => [c.combo, drawClass(c.combo, board)]));
    sections.push({
      id: "made",
      label: "Made hands",
      groups: MADE_CLASSES.map((k) => ({ id: `made:${k}`, label: MADE_LABELS[k], test: (c: RangeCombo) => made.get(c.combo) === k })),
    });
    if (board.length < 5) {
      sections.push({
        id: "draw",
        label: "Draws",
        groups: DRAW_CLASSES.map((k) => ({ id: `draw:${k}`, label: DRAW_LABELS[k], test: (c: RangeCombo) => draw.get(c.combo) === k })),
      });
    }
  }
  const actor = stats?.players[stats.actor];
  if (actor) {
    const eq = (c: RangeCombo) => actor.equity[c.combo];
    const band = (lo: number, hi: number) => (c: RangeCombo) => {
      const e = eq(c);
      return e != null && e >= lo && e < hi;
    };
    sections.push({
      id: "equity",
      label: "Equity",
      groups: [
        { id: "eq:75", label: "Equity 75+", test: band(75, Infinity) },
        { id: "eq:50", label: "Equity 50–75", test: band(50, 75) },
        { id: "eq:25", label: "Equity 25–50", test: band(25, 50) },
        { id: "eq:0", label: "Equity < 25", test: band(-Infinity, 25) },
      ],
    });
  }
  if (stats?.ev && potBb && potBb > 0) {
    const pct = (c: RangeCombo) => {
      const v = stats.ev!.node[c.combo];
      return v == null ? null : (v / potBb) * 100;
    };
    const band = (lo: number, hi: number) => (c: RangeCombo) => {
      const p = pct(c);
      return p != null && p >= lo && p < hi;
    };
    sections.push({
      id: "ev",
      label: "EV (% of pot)",
      groups: [
        { id: "ev:100", label: "EV 100+", test: band(100, Infinity) },
        { id: "ev:75", label: "EV 75–100", test: band(75, 100) },
        { id: "ev:50", label: "EV 50–75", test: band(50, 75) },
        { id: "ev:25", label: "EV 25–50", test: band(25, 50) },
        { id: "ev:0", label: "EV < 25", test: band(-Infinity, 25) },
      ],
    });
  }
  return sections
    .map((s) => ({ ...s, groups: s.groups.filter((g) => range.some(g.test)) }))
    .filter((s) => s.groups.length > 0);
}

/**
 * The filter made of the groups picked: a combo passes when, in every section
 * with a group picked, it is in one of them (OR within a section, AND across,
 * like "top pair" + "flush draw"). Null when nothing is picked.
 */
export function groupFilter(sections: QuickSection[], picked: Set<string>): ((c: RangeCombo) => boolean) | null {
  const active = sections
    .map((s) => s.groups.filter((g) => picked.has(g.id)))
    .filter((gs) => gs.length > 0);
  if (active.length === 0) return null;
  return (c) => active.every((gs) => gs.some((g) => g.test(c)));
}

/* ---------------------------------------------------------------- suits */

/** Per suit: kept only ("in", left click) or left out ("out", right click). */
export type SuitMarks = Partial<Record<Suit, "in" | "out">>;
/** Suits of the high card and of the low card of a combo. */
export type SuitFilter = { high: SuitMarks; low: SuitMarks };

export const NO_SUITS: SuitFilter = { high: {}, low: {} };

function fits(marks: SuitMarks, suit: Suit): boolean {
  if (marks[suit] === "out") return false;
  const ins = Object.values(marks).filter((m) => m === "in").length;
  return ins === 0 || marks[suit] === "in";
}

/**
 * The combos whose high card and low card have the suits asked. A pair has
 * no high card: either of its cards may be the "high" one.
 */
export function suitFilter(f: SuitFilter): ((c: RangeCombo) => boolean) | null {
  if (Object.keys(f.high).length === 0 && Object.keys(f.low).length === 0) return null;
  return (c) => {
    const [a, b] = comboCards(c.combo);
    const va = RANKS.indexOf(cardRank(a));
    const vb = RANKS.indexOf(cardRank(b));
    const as = cardSuit(a);
    const bs = cardSuit(b);
    const ok = (hi: Suit, lo: Suit) => fits(f.high, hi) && fits(f.low, lo);
    if (va === vb) return ok(as, bs) || ok(bs, as);
    return va < vb ? ok(as, bs) : ok(bs, as);
  };
}

/** Both filters (null when neither is on). */
export function bothFilters(
  a: ((c: RangeCombo) => boolean) | null,
  b: ((c: RangeCombo) => boolean) | null,
): ((c: RangeCombo) => boolean) | null {
  if (!a) return b;
  if (!b) return a;
  return (c) => a(c) && b(c);
}
