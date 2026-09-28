/**
 * The runouts report of a node where the next card is dealt: for every turn
 * (or river) card of the save, both players' equity and EV and the average
 * strategy of the player to act — to choose which runouts to study. And the
 * user's groups of runouts ("bricks", "flush cards"…), each with one card
 * picked to study for the whole group. Pure functions only.
 */

import { CHIPS_PER_BB } from "./csvImport";
import { RANKS, type Suit } from "./cards";
import { pioActions, toStrategyActions, type PioAction, type PioPlayer, type PioRunouts } from "./pio";
import type { ActionKind } from "./types";

export type RunoutRow = {
  card: string;
  /** Equity in %, by player. */
  equity: Partial<Record<PioPlayer, number>>;
  /** EV in bb, by player. */
  ev: Partial<Record<PioPlayer, number>>;
  /** % of each of the report's `actions` (null where the card has no decision). */
  strategy: number[] | null;
};

export type RunoutReport = {
  file: string;
  /** The split node. */
  pioId: string;
  fetchedAt: string;
  /** Who acts first after the card. */
  actor: PioPlayer | null;
  actions: { label: string; kind: ActionKind; color: string }[];
  rows: RunoutRow[];
  /** Cards not in the save (rivers of a no_rivers save). */
  missing: string[];
};

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** The bridge's answer, the app's way (labels, %, bb). */
export function runoutReport(r: PioRunouts, stackChips: number, fetchedAt: string): RunoutReport {
  const labels: PioAction[] = [];
  const perCard = r.cards.map((c) => {
    const pa = c.node.player && c.children.length ? pioActions(c.node, c.children, c.node.pot, stackChips) : [];
    for (const a of pa) if (!labels.some((l) => l.label === a.label)) labels.push(a);
    return { c, pa };
  });
  // Biggest bets first, then check / call, then fold: the solver's order.
  const colors = toStrategyActions(labels).map((a) => a.color);
  const actions = labels.map((l, i) => ({ label: l.label, kind: l.kind, color: colors[i] }));
  const rows: RunoutRow[] = [];
  const missing: string[] = [];
  let actor: PioPlayer | null = null;
  for (const { c, pa } of perCard) {
    if (!c.node.solved) {
      missing.push(c.card);
      continue;
    }
    actor ??= c.node.player ?? null;
    const equity: RunoutRow["equity"] = {};
    const ev: RunoutRow["ev"] = {};
    for (const p of ["OOP", "IP"] as PioPlayer[]) {
      const e = c.equity[p];
      if (e != null && Number.isFinite(e)) equity[p] = round(e * 100);
      const v = c.ev[p];
      if (v != null && Number.isFinite(v)) ev[p] = round(v / CHIPS_PER_BB, 3);
    }
    let strategy: number[] | null = null;
    if (c.strategy && pa.length) {
      strategy = actions.map((a) => {
        const i = pa.findIndex((x) => x.label === a.label);
        const f = i >= 0 ? c.strategy![i] : 0;
        return f == null ? 0 : round(f * 100, 1);
      });
    }
    rows.push({ card: c.card, equity, ev, strategy });
  }
  return { file: r.file, pioId: r.node.id, fetchedAt, actor, actions, rows, missing };
}

export function asRunoutReport(raw: unknown): RunoutReport | null {
  const r = raw as Partial<RunoutReport> | null;
  if (!r || !Array.isArray(r.rows) || !Array.isArray(r.actions) || typeof r.file !== "string") return null;
  return { missing: [], actor: null, pioId: "", fetchedAt: "", ...r } as RunoutReport;
}

/** The average of some runouts (each card counts the same). */
export type RunoutSummary = {
  cards: number;
  equity: Partial<Record<PioPlayer, number>>;
  ev: Partial<Record<PioPlayer, number>>;
  strategy: number[] | null;
};

export function summarizeRunouts(rows: RunoutRow[], actionCount: number): RunoutSummary {
  const avg = (vals: (number | undefined)[]) => {
    const xs = vals.filter((x): x is number => x != null && Number.isFinite(x));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
  };
  const equity: RunoutSummary["equity"] = {};
  const ev: RunoutSummary["ev"] = {};
  for (const p of ["OOP", "IP"] as PioPlayer[]) {
    const e = avg(rows.map((r) => r.equity[p]));
    if (e != null) equity[p] = e;
    const v = avg(rows.map((r) => r.ev[p]));
    if (v != null) ev[p] = v;
  }
  const withStrat = rows.filter((r) => r.strategy);
  const strategy = withStrat.length
    ? Array.from({ length: actionCount }, (_, i) => withStrat.reduce((a, r) => a + (r.strategy![i] ?? 0), 0) / withStrat.length)
    : null;
  return { cards: rows.length, equity, ev, strategy };
}

/* ---------------------------------------------------------------- groups */

export type RunoutGroup = {
  id: string;
  name: string;
  color: string;
  cards: string[];
  /** The card studied for the whole group. */
  study: string | null;
};

export function asRunoutGroups(raw: unknown): RunoutGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g): g is RunoutGroup => !!g && typeof g.id === "string" && typeof g.name === "string")
    .map((g) => ({
      id: g.id,
      name: g.name,
      color: typeof g.color === "string" ? g.color : "#64748b",
      cards: Array.isArray(g.cards) ? g.cards.filter((c): c is string => typeof c === "string") : [],
      study: typeof g.study === "string" ? g.study : null,
    }))
    .map((g) => ({ ...g, study: g.study && g.cards.includes(g.study) ? g.study : null }));
}

/** Put cards in a group (null = out of every group); a card is in one group at most. */
export function assignCards(groups: RunoutGroup[], cards: string[], target: string | null): RunoutGroup[] {
  const moving = new Set(cards);
  return groups.map((g) => {
    const kept = g.cards.filter((c) => !moving.has(c));
    const next = g.id === target ? [...kept, ...cards.filter((c) => !kept.includes(c))] : kept;
    return { ...g, cards: next, study: g.study && next.includes(g.study) ? g.study : null };
  });
}

/**
 * The card of a group that plays most like the group: the closest to its
 * average (equity, EV and strategy of the player to act, each scaled).
 */
export function typicalCard(rows: RunoutRow[], cards: string[]): string | null {
  const mine = rows.filter((r) => cards.includes(r.card));
  if (mine.length === 0) return null;
  const n = mine[0].strategy?.length ?? 0;
  const s = summarizeRunouts(mine, n);
  let best: string | null = null;
  let bestD = Infinity;
  for (const r of mine) {
    let d = 0;
    for (const p of ["OOP", "IP"] as PioPlayer[]) {
      if (r.equity[p] != null && s.equity[p] != null) d += ((r.equity[p]! - s.equity[p]!) / 10) ** 2;
      if (r.ev[p] != null && s.ev[p] != null) d += ((r.ev[p]! - s.ev[p]!) / Math.max(1, Math.abs(s.ev[p]!))) ** 2;
    }
    if (r.strategy && s.strategy) for (let i = 0; i < n; i++) d += ((r.strategy[i] - s.strategy[i]) / 25) ** 2;
    if (d < bestD) {
      bestD = d;
      best = r.card;
    }
  }
  return best;
}

/** Report layout: suits top to bottom (♣ ♦ ♥ ♠, like Pio), ranks 2 → A. */
export const REPORT_SUITS: Suit[] = ["c", "d", "h", "s"];
export const REPORT_RANKS = [...RANKS].reverse();
