/**
 * Domain types for the /poker/spots solver-notes tool.
 *
 * A spot is all or part of the game tree of one heads-up hand: a setup (who
 * plays, where the tree starts, pot and stacks) and nodes below it — decisions
 * (`strategy`), the options taken (`action`) and the cards dealt (`flop`,
 * `turn`, `river`). The state of the hand at each node is computed by
 * `gameState.ts`, never stored.
 *
 * DB-shaped rows use snake_case to mirror the columns; the type-specific `data`
 * payloads inside a node use camelCase, matching the agenda feature's split
 * between DB rows and client view-models. `data` is stored as jsonb, so it
 * arrives as `unknown` and is narrowed per node type by the helpers below.
 */

import { derivedPosition, isSeat, type Seat } from "./seats";
import type { PioLink, PlayerStats, StrategyStats } from "./pio";
import type { HandCategory } from "./categories";

export type Street = "preflop" | "flop" | "turn" | "river";

export const STREETS: Street[] = ["preflop", "flop", "turn", "river"];

export const STREET_LABELS: Record<Street, string> = {
  preflop: "Preflop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
};

export type NodeType = "flop" | "turn" | "river" | "strategy" | "action";

export const NODE_TYPES: NodeType[] = [
  "flop",
  "turn",
  "river",
  "strategy",
  "action",
];

export const NODE_LABELS: Record<NodeType, string> = {
  flop: "Flop",
  turn: "Turn",
  river: "River",
  strategy: "Decision",
  action: "Action",
};

/** One spot / tree the user edits (e.g. "BTN vs BB SRP"). */
export type PokerSpot = {
  id: string;
  name: string;
  description: string | null;
  /** jsonb, narrowed with `asSetup`. Null until the spot is set up. */
  setup: unknown;
  created_at: string;
  updated_at: string;
};

/**
 * Where the tree starts. Preflop: blinds posted from `stackBb`, the pot is
 * computed. Any later street: `potBb` and `stackBb` are what they are when
 * that street's betting starts, and the board is dealt by the first card
 * nodes. The root also carries notes, like any node.
 */
export type SpotSetup = {
  players: [Seat, Seat] | null;
  street: Street;
  /** Pot when betting starts (postflop starts only). */
  potBb: number | null;
  /** Effective stack behind: before the blinds preflop, at the street start otherwise. */
  stackBb: number;
  summary?: string;
  notes?: string;
};

export function asSetup(raw: unknown): SpotSetup {
  const d = (raw ?? {}) as Partial<SpotSetup> & { players?: unknown };
  const players =
    Array.isArray(d.players) && d.players.length === 2 && isSeat(d.players[0]) && isSeat(d.players[1]) && d.players[0] !== d.players[1]
      ? ([d.players[0], d.players[1]] as [Seat, Seat])
      : null;
  const street = (STREETS as string[]).includes(d.street as string) ? (d.street as Street) : "preflop";
  const pot = Number(d.potBb);
  const stack = Number(d.stackBb);
  return {
    players,
    street,
    potBb: Number.isFinite(pot) && pot > 0 ? pot : null,
    stackBb: Number.isFinite(stack) && stack > 0 ? stack : 100,
    summary: typeof d.summary === "string" ? d.summary : "",
    notes: typeof d.notes === "string" ? d.notes : "",
  };
}

/** Why a setup can't start a hand yet, or null when it can. */
export function setupProblem(setup: SpotSetup): string | null {
  if (!setup.players) return "Set who plays this spot (two seats).";
  if (setup.street !== "preflop" && !setup.potBb) return `Set the pot at the start of the ${setup.street}.`;
  return null;
}

/** A node as stored. `data` is narrowed with the `*Data` guards below. */
export type PokerNode = {
  id: string;
  spot_id: string;
  parent_id: string | null;
  type: NodeType;
  position: number;
  data: NodeData;
  created_at: string;
  updated_at: string;
};

export type NodeData =
  | FlopData
  | StreetData
  | StrategyData
  | ActionData
  | NodeMeta
  | Record<string, never>;

/**
 * Free-form notes every node type can carry alongside its own payload: a short
 * summary shown under the node's title and extensive Markdown notes. They live in
 * the same `data` jsonb; the spot page merges patches into it, so type-specific
 * edits never drop them.
 */
export type NodeMeta = {
  summary?: string;
  notes?: string;
  override?: StateOverride | null;
  /**
   * Where this node sits in a PioSOLVER save. On a flop node it links the
   * whole line below to that save; on an imported decision it also keeps the
   * solver's pot and stack there.
   */
  pio?: PioLink | null;
  /** On a decision: the user's split of the range into named groups. */
  categories?: HandCategory[];
};

/**
 * The hand's state forced at a node, for when the action above can't give it
 * (a bet with no sizing, a skipped part of the tree). Everything below starts
 * from these values.
 */
export type StateOverride = {
  /** Total pot, bets in front included. */
  potBb: number;
  /** Effective stack behind. */
  stackBb: number;
};

/**
 * How a sizing is read. `pct`: % of the pot (a raise calls first). `bb`: an
 * amount in big blinds — raise-to for a raise, the chips put in for a bet.
 * Null: the street's default, bb preflop and % postflop.
 */
export type SizeUnit = "pct" | "bb";

export type FlopData = { cards: string[] }; // up to 3 cards like "Ah"
export type StreetData = { card: string | null }; // turn / river
export type StrategyData = {
  label?: string;
  /**
   * IP / OOP. Set by hand on older nodes; derived from `seat` / `vsSeat` as
   * soon as both are set, and kept in sync by the inspector.
   */
  position?: "OOP" | "IP" | null;
  /** Legacy: set by hand before seats were derived from the tree. Ignored. */
  seat?: Seat | null;
  /** Legacy, ignored. */
  vsSeat?: Seat | null;
  actions: StrategyAction[];
};
export type ActionData = {
  /** When the parent is a strategy node, which of its actions this represents. */
  strategyActionId?: string | null;
  kind: ActionKind;
  sizePct?: number | null;
  sizeUnit?: SizeUnit | null;
  label: string;
  color: string;
};

export type ActionKind = "check" | "bet" | "raise" | "call" | "fold";

export const ACTION_KINDS: ActionKind[] = [
  "check",
  "bet",
  "raise",
  "call",
  "fold",
];

export const ACTION_KIND_LABELS: Record<ActionKind, string> = {
  check: "Check",
  bet: "Bet",
  raise: "Raise",
  call: "Call",
  fold: "Fold",
};

/** Does this action kind carry a sizing (% of pot)? */
export function kindHasSize(kind: ActionKind): boolean {
  return kind === "bet" || kind === "raise";
}

export type StrategyAction = {
  id: string;
  kind: ActionKind;
  /** Sizing for bet/raise, read in `sizeUnit` (the name predates bb sizes). */
  sizePct?: number | null;
  sizeUnit?: SizeUnit | null;
  label: string;
  color: string;
};

/**
 * The per-hand action distribution of a strategy node, stored 1:1 in
 * poker_strategies. Each vector aligns to the node's `actions` order and holds
 * percentages (0–100). `combos` overrides `hands` for specific exact combos.
 */
export type StrategyWeights = {
  hands: Record<string, number[]>;
  combos: Record<string, number[]>;
};

export function emptyWeights(): StrategyWeights {
  return { hands: {}, combos: {} };
}

/* ------------------------------------------------------------- narrowing */

export function asFlop(node: PokerNode): FlopData {
  const d = node.data as Partial<FlopData>;
  return { cards: Array.isArray(d.cards) ? d.cards : [] };
}

export function asStreet(node: PokerNode): StreetData {
  const d = node.data as Partial<StreetData>;
  return { card: typeof d.card === "string" ? d.card : null };
}

export function asStrategy(node: PokerNode): StrategyData {
  const d = node.data as Partial<StrategyData>;
  const seat = isSeat(d.seat) ? d.seat : null;
  const vsSeat = isSeat(d.vsSeat) ? d.vsSeat : null;
  return {
    label: d.label,
    position: derivedPosition(seat, vsSeat) ?? d.position ?? null,
    seat,
    vsSeat,
    actions: Array.isArray(d.actions) ? d.actions : [],
  };
}

/** What a card shows for a strategy's position: "BTN vs BB" once seated, else IP / OOP. */
export function strategyPositionText(data: StrategyData): string | null {
  if (data.seat && data.vsSeat) return `${data.seat} vs ${data.vsSeat}`;
  return data.position ?? null;
}

export function asAction(node: PokerNode): ActionData {
  const d = node.data as Partial<ActionData>;
  return {
    strategyActionId: d.strategyActionId ?? null,
    kind: d.kind ?? "check",
    sizePct: d.sizePct ?? null,
    sizeUnit: d.sizeUnit === "bb" || d.sizeUnit === "pct" ? d.sizeUnit : null,
    label: d.label ?? "Action",
    color: d.color ?? "#64748b",
  };
}

export function asMeta(node: PokerNode): { summary: string; notes: string } {
  const d = node.data as NodeMeta;
  return {
    summary: typeof d.summary === "string" ? d.summary : "",
    notes: typeof d.notes === "string" ? d.notes : "",
  };
}

/** The solver link on a node (see NodeMeta.pio), when it names a save and a node. */
export function asPio(node: PokerNode): PioLink | null {
  const p = (node.data as NodeMeta).pio;
  if (!p || typeof p.file !== "string" || typeof p.id !== "string" || !p.file || !p.id) return null;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  return {
    file: p.file,
    id: p.id,
    potBb: num(p.potBb),
    stackBb: num(p.stackBb),
    importedAt: typeof p.importedAt === "string" ? p.importedAt : undefined,
  };
}

export type { PioLink, PlayerStats, StrategyStats };

/** The state override on a node, when it holds two positive numbers. */
export function asOverride(node: PokerNode): StateOverride | null {
  const o = (node.data as NodeMeta).override;
  if (!o) return null;
  const potBb = Number(o.potBb);
  const stackBb = Number(o.stackBb);
  if (!Number.isFinite(potBb) || potBb <= 0 || !Number.isFinite(stackBb) || stackBb < 0) return null;
  return { potBb, stackBb };
}

/** "Bet 33%" / "Raise 12bb" — the unit a sizing is read in, for display. */
export function sizeText(sizePct: number | null | undefined, unit: SizeUnit | null | undefined, street: Street): string {
  if (sizePct == null) return "all-in";
  const u = unit ?? (street === "preflop" ? "bb" : "pct");
  const n = Number.isInteger(sizePct) ? String(sizePct) : String(Math.round(sizePct * 100) / 100);
  return u === "bb" ? `${n}bb` : `${n}%`;
}
