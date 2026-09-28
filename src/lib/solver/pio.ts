/**
 * PioSOLVER data (as PioBridge returns it) → the spot model. Pure functions.
 *
 * Solver conventions (checked on real saves, see tools/pio-bridge):
 * - Node ids: `r` is the tree root (the flop dealt), `r:0` the first decision,
 *   then one token per step: `c` check / call, `f` fold, `bN` bet / raise, a
 *   card (`7h`) for a card dealt. A card token leads straight to the first
 *   decision of the new street.
 * - `bN` and a node's pot `{oop, ip}` are the chips each player has put in
 *   during the whole hand (not the street); `start` is the pot when the tree
 *   starts. Chips are the NL1000 export's: 10 to the big blind.
 * - Vectors hold 1326 values in the solver's hand order (`2d2c … AsAh`).
 *   Combos out of range are null in EV / equity.
 * - Children of a decision come in strategy-row order: bets from the biggest,
 *   then check / call, then fold.
 */

import { comboBlocked, comboToHand } from "./cards";
import { actionColors } from "./colors";
import { CHIPS_PER_BB, normalizeCombo } from "./csvImport";
import { fmtBb } from "./gameState";
import { isSeat, type Seat } from "./seats";
import type { ActionKind, SizeUnit, StrategyAction, StrategyWeights } from "./types";

/* ------------------------------------------------------------ bridge shapes */

export type PioPlayer = "OOP" | "IP";

export type PioPot = { oop: number; ip: number; start: number };

export type PioNode = {
  id: string;
  /** ROOT · OOP_DEC · IP_DEC · SPLIT_NODE · END_NODE */
  type: string;
  player?: PioPlayer;
  last?: string;
  board: string[];
  pot: PioPot;
  children: number;
  flags: string[];
  /** False for nodes the save does not hold (rivers of a no_rivers save). */
  solved: boolean;
};

/** A vector from the bridge: null where the solver has no value. */
export type PioVector = (number | null)[];

export type PioDecision = {
  file: string;
  node: PioNode;
  children: PioNode[];
  player: PioPlayer;
  strategy: PioVector[];
  range: PioVector;
  villainRange?: PioVector;
  globalFreq?: number;
  stats?: {
    unit: "chips";
    equity: PioVector;
    equityWeights: PioVector;
    equityTotal: number;
    ev: PioVector;
    evWeights: PioVector;
    childEv: (PioVector | null)[];
    villainEquity?: PioVector;
    villainEquityWeights?: PioVector;
    villainEquityTotal?: number;
    villainEv?: PioVector;
    villainEvWeights?: PioVector;
    notes: string[];
  };
  ms: number;
};

/** A split node's cards summed up (bridge `/api/runouts`). */
export type PioRunouts = {
  file: string;
  node: PioNode;
  cards: {
    card: string;
    node: PioNode;
    children: PioNode[];
    /** Average frequency of each child over the actor's range (0–1). */
    strategy?: PioVector;
    /** Solver equity totals (0–1) and range EVs (chips), by player. */
    equity: Partial<Record<PioPlayer, number | null>>;
    ev: Partial<Record<PioPlayer, number | null>>;
    notes: string[];
  }[];
  ms: number;
};

export type PioTree = {
  file: string;
  board: string[];
  root: PioNode;
  first: PioNode;
  effectiveStack: number;
  info: Record<string, string>;
  infoBoardMatches: boolean;
  ranges: { oop: PioVector; ip: PioVector };
};

/* ------------------------------------------------------------------ ids */

export function pioTokens(id: string): string[] {
  return id.split(":").slice(1);
}

export function isCardToken(t: string): boolean {
  return /^[2-9TJQKA][cdhs]$/.test(t);
}

/** The first decision of the street `id` is on (the node its pot started from). */
export function streetStartId(id: string): string {
  const parts = id.split(":");
  for (let i = parts.length - 1; i >= 1; i--) {
    if (isCardToken(parts[i])) return parts.slice(0, i + 1).join(":");
  }
  return parts.length > 1 ? "r:0" : "r";
}

export function other(p: PioPlayer): PioPlayer {
  return p === "OOP" ? "IP" : "OOP";
}

const inHand = (pot: PioPot, p: PioPlayer) => (p === "OOP" ? pot.oop : pot.ip);

/* -------------------------------------------------------------- actions */

export type PioAction = {
  kind: ActionKind;
  /** bb put in for a bet, raise-to (street total) for a raise; null otherwise. */
  sizeBb: number | null;
  /** The bet as % of the pot before it (bets only). */
  potPct: number | null;
  allIn: boolean;
  label: string;
  /** The child it leads to. */
  childId: string;
};

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * The options of a decision, the app's way. `streetStart` is the pot of the
 * street's first decision (both players had put in the same then);
 * `stackChips` is the effective stack of the tree (an all-in is a bet of it).
 */
export function pioActions(
  node: PioNode,
  children: PioNode[],
  streetStart: PioPot,
  stackChips: number,
): PioAction[] {
  const player = node.player ?? "OOP";
  const mine = inHand(node.pot, player);
  const theirs = inHand(node.pot, other(player));
  const facing = theirs > mine;
  const street = inHand(streetStart, player);
  const potNow = node.pot.oop + node.pot.ip + node.pot.start;
  return children.map((child) => {
    const t = child.last ?? pioTokens(child.id).at(-1) ?? "";
    if (t === "f") return { kind: "fold", sizeBb: null, potPct: null, allIn: false, label: "Fold", childId: child.id };
    if (t === "c") {
      const kind: ActionKind = facing ? "call" : "check";
      return { kind, sizeBb: null, potPct: null, allIn: false, label: facing ? "Call" : "Check", childId: child.id };
    }
    const total = Number(t.slice(1));
    const allIn = total >= stackChips;
    if (!facing) {
      const put = total - mine;
      const pct = potNow > 0 ? (put / potNow) * 100 : 0;
      return {
        kind: "bet",
        sizeBb: round(put / CHIPS_PER_BB, 3),
        potPct: round(pct, 1),
        allIn,
        label: allIn ? "All-in" : `Bet ${Math.round(pct)}%`,
        childId: child.id,
      };
    }
    const to = (total - street) / CHIPS_PER_BB;
    return {
      kind: "raise",
      sizeBb: round(to, 3),
      potPct: null,
      allIn,
      label: allIn ? "All-in" : `Raise ${fmtBb(to)}bb`,
      childId: child.id,
    };
  });
}

/**
 * The strategy actions for a decision. An existing action with the same kind
 * and size keeps its id (and all-ins match each other), so action nodes
 * already linked to it stay linked after a re-import — CSV imports store the
 * same bb sizes, so they are matched too.
 */
export function toStrategyActions(pa: PioAction[], existing: StrategyAction[] = []): StrategyAction[] {
  const colors = actionColors(pa.map((a) => ({ kind: a.kind, sizePct: a.sizeBb, label: a.label })));
  const taken = new Set<string>();
  const close = (x: number | null | undefined, y: number | null) => x != null && y != null && Math.abs(x - y) < 0.051;
  return pa.map((a, i) => {
    const same = (e: StrategyAction) => {
      if (taken.has(e.id) || !sameKind(e.kind, a.kind)) return false;
      if (a.kind === "fold" || a.kind === "check" || a.kind === "call") return true;
      const eAllIn = e.sizePct == null || /all.?in|jam|shove/i.test(e.label);
      if (a.allIn || eAllIn) return a.allIn && eAllIn;
      return e.sizeUnit === "bb" ? close(e.sizePct, a.sizeBb) : close(e.sizePct, a.potPct);
    };
    const match = existing.find(same);
    if (match) taken.add(match.id);
    const unit: SizeUnit | null = a.sizeBb == null ? null : "bb";
    return {
      id: match?.id ?? crypto.randomUUID(),
      kind: a.kind,
      sizePct: a.sizeBb,
      sizeUnit: unit,
      label: a.label,
      color: colors[i],
    };
  });
}

function sameKind(a: ActionKind, b: ActionKind): boolean {
  const norm = (k: ActionKind) => (k === "raise" ? "bet" : k === "call" ? "check" : k);
  return norm(a) === norm(b);
}

/**
 * Which Pio option an app action is. Check / call and fold by kind; a bet or
 * raise by size in its own unit (bb, or % of the pot), all-in to all-in.
 */
export function matchPioAction(
  target: { kind: ActionKind; sizePct?: number | null; sizeUnit?: SizeUnit | null; label: string },
  options: PioAction[],
): PioAction | null {
  if (target.kind === "fold") return options.find((o) => o.kind === "fold") ?? null;
  if (target.kind === "check" || target.kind === "call") {
    return options.find((o) => o.kind === "check" || o.kind === "call") ?? null;
  }
  const aggressive = options.filter((o) => o.kind === "bet" || o.kind === "raise");
  if (target.sizePct == null || /all.?in|jam|shove/i.test(target.label)) {
    return aggressive.find((o) => o.allIn) ?? null;
  }
  const want = target.sizePct;
  const value = (o: PioAction) => (target.sizeUnit === "bb" ? o.sizeBb : (o.potPct ?? null));
  let best: PioAction | null = null;
  let bestDiff = Infinity;
  for (const o of aggressive) {
    const v = value(o);
    if (v == null) continue;
    const d = Math.abs(v - want) / Math.max(1, want);
    if (d < bestDiff) {
      best = o;
      bestDiff = d;
    }
  }
  // Sizes within 10% are the same option (rounding in labels, manual trees).
  return bestDiff <= 0.1 ? best : null;
}

/* --------------------------------------------------------------- grids */

/**
 * The acting player's strategy as a grid: each combo's action frequencies (in
 * %) scaled by how much of it is in range at this node, so a combo at 40%
 * reach weighs 0.4 — the grid's cell height, global frequencies and trainer
 * dealing all read range that way. Like the CSV import, each hand stores the
 * average of its live combos, and combos that differ from it as overrides.
 */
export function pioWeights(d: PioDecision, handOrder: string[], board: string[]): StrategyWeights {
  const dead = new Set(board);
  const n = d.strategy.length;
  const byHand = new Map<string, { combo: string; vec: number[] }[]>();
  for (let h = 0; h < handOrder.length; h++) {
    const combo = normalizeCombo(handOrder[h]);
    if (!combo || comboBlocked(combo, dead)) continue;
    const r = d.range[h] ?? 0;
    const vec = d.strategy.map((row) => round((row[h] ?? 0) * 100 * Math.max(0, r)));
    const hand = comboToHand(combo);
    const list = byHand.get(hand) ?? [];
    list.push({ combo, vec });
    byHand.set(hand, list);
  }
  const hands: Record<string, number[]> = {};
  const combos: Record<string, number[]> = {};
  for (const [hand, list] of byHand) {
    const avg = new Array<number>(n).fill(0);
    for (const { vec } of list) for (let i = 0; i < n; i++) avg[i] += vec[i] / list.length;
    const handVec = avg.map((x) => round(x));
    if (handVec.every((x) => x === 0) && list.every(({ vec }) => vec.every((x) => x === 0))) continue;
    hands[hand] = handVec;
    for (const { combo, vec } of list) {
      if (vec.some((x, i) => Math.abs(x - handVec[i]) > 0.05)) combos[combo] = vec;
    }
  }
  return { hands, combos };
}

/* --------------------------------------------------------------- stats */

export type PlayerStats = {
  /** Reach at this node, 0–1, combos in range only. */
  range: Record<string, number>;
  /** Equity in %, combos in range only. */
  equity: Record<string, number>;
  /** The solver's range equity, in %. */
  equityTotal: number | null;
  /** EV at this node, in bb (imports from 2026-09-29 on; the actor's is also in `ev.node`). */
  ev?: Record<string, number>;
  evTotal?: number | null;
};

/**
 * What an import stores next to the grid (poker_strategies.stats): both
 * players' ranges and equities, and the acting player's EV — of the node and
 * of each action — in bb.
 */
export type StrategyStats = {
  source: "pio";
  file: string;
  pioId: string;
  importedAt: string;
  actor: PioPlayer;
  seats: { OOP: Seat; IP: Seat } | null;
  players: Partial<Record<PioPlayer, PlayerStats>>;
  ev: {
    node: Record<string, number>;
    /** Per combo, one value per action (null where the solver gave none). */
    actions: Record<string, (number | null)[]>;
    total: number | null;
    /** Average EV of each action over the combos taking it. */
    actionTotals: (number | null)[];
  } | null;
  notes: string[];
};

function weightedMean(values: PioVector, weights: PioVector, extra?: (h: number) => number): number | null {
  let sum = 0;
  let w = 0;
  for (let h = 0; h < values.length; h++) {
    const v = values[h];
    const wt = (weights[h] ?? 0) * (extra ? extra(h) : 1);
    if (v == null || !Number.isFinite(v) || wt <= 0) continue;
    sum += v * wt;
    w += wt;
  }
  return w > 0 ? sum / w : null;
}

export function pioStats(
  d: PioDecision,
  handOrder: string[],
  opts: { seats: { OOP: Seat; IP: Seat } | null; importedAt: string },
): StrategyStats | null {
  const st = d.stats;
  if (!st) return null;
  const keys = handOrder.map((h) => normalizeCombo(h));
  const player = (range: PioVector | undefined, eq: PioVector | undefined, total: number | undefined): PlayerStats | undefined => {
    if (!range) return undefined;
    const out: PlayerStats = { range: {}, equity: {}, equityTotal: total != null ? round(total * 100, 2) : null };
    for (let h = 0; h < keys.length; h++) {
      const k = keys[h];
      const r = range[h] ?? 0;
      if (!k || r <= 0) continue;
      out.range[k] = round(r, 4);
      const e = eq?.[h];
      if (e != null && Number.isFinite(e)) out.equity[k] = round(e * 100, 1);
    }
    return out;
  };
  const actor = d.player;
  const players: Partial<Record<PioPlayer, PlayerStats>> = {};
  players[actor] = player(d.range, st.equity, st.equityTotal);
  const villain = player(d.villainRange, st.villainEquity, st.villainEquityTotal);
  if (villain) players[other(actor)] = villain;

  const toBb = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : round(x / CHIPS_PER_BB, 3));
  const node: Record<string, number> = {};
  const actions: Record<string, (number | null)[]> = {};
  for (let h = 0; h < keys.length; h++) {
    const k = keys[h];
    if (!k || (d.range[h] ?? 0) <= 0) continue;
    const v = toBb(st.ev[h]);
    if (v != null) node[k] = v;
    actions[k] = st.childEv.map((c) => toBb(c?.[h]));
  }
  const total = weightedMean(st.ev, st.evWeights);
  const evOf = (values: PioVector | undefined, range: PioVector | undefined) => {
    const out: Record<string, number> = {};
    if (!values || !range) return out;
    for (let h = 0; h < keys.length; h++) {
      const k = keys[h];
      if (!k || (range[h] ?? 0) <= 0) continue;
      const v = toBb(values[h]);
      if (v != null) out[k] = v;
    }
    return out;
  };
  const actorStats = players[actor];
  if (actorStats) {
    actorStats.ev = node;
    actorStats.evTotal = total == null ? null : round(total / CHIPS_PER_BB, 3);
  }
  const villainStats = players[other(actor)];
  if (villainStats && st.villainEv) {
    villainStats.ev = evOf(st.villainEv, d.villainRange);
    const vt = st.villainEvWeights ? weightedMean(st.villainEv, st.villainEvWeights) : null;
    villainStats.evTotal = vt == null ? null : round(vt / CHIPS_PER_BB, 3);
  }
  const actionTotals = st.childEv.map((c, i) =>
    c ? weightedMean(c, st.evWeights, (h) => d.strategy[i]?.[h] ?? 0) : null,
  );
  return {
    source: "pio",
    file: d.file,
    pioId: d.node.id,
    importedAt: opts.importedAt,
    actor,
    seats: opts.seats,
    players,
    ev: {
      node,
      actions,
      total: total == null ? null : round(total / CHIPS_PER_BB, 3),
      actionTotals: actionTotals.map((x) => (x == null ? null : round(x / CHIPS_PER_BB, 3))),
    },
    notes: st.notes ?? [],
  };
}

/* ------------------------------------------------------- pot and stacks */

/** Where a node links to a save: stored in the node's data as `pio`. */
export type PioLink = {
  file: string;
  /** The solver node this app node stands for. */
  id: string;
  /** Pot (bets in front included) and effective stack behind, in bb, as the solver has them. */
  potBb?: number;
  stackBb?: number;
  importedAt?: string;
};

export function pioSnapshot(node: PioNode, stackChips: number): { potBb: number; stackBb: number } {
  const pot = node.pot.oop + node.pot.ip + node.pot.start;
  const behind = stackChips - Math.max(node.pot.oop, node.pot.ip);
  return { potBb: round(pot / CHIPS_PER_BB, 3), stackBb: round(behind / CHIPS_PER_BB, 3) };
}

/** The spot's start (flop) from a save: pot and stacks when the flop betting starts. */
export function setupFromTree(tree: PioTree): { potBb: number; stackBb: number } {
  return {
    potBb: round(tree.root.pot.start / CHIPS_PER_BB, 3),
    stackBb: round(tree.effectiveStack / CHIPS_PER_BB, 3),
  };
}

/** Two seats named in a path, e.g. "BB vs BTN/…/8h5d3d.cfr" → ["BB", "BTN"]. */
export function seatsFromPath(path: string): [Seat, Seat] | null {
  const found: Seat[] = [];
  for (const w of path.toUpperCase().split(/[^A-Z]+/)) {
    if (isSeat(w) && !found.includes(w)) found.push(w);
  }
  return found.length === 2 ? [found[0], found[1]] : null;
}
