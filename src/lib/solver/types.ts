/**
 * Domain types for the /poker/spots solver-notes tool.
 *
 * DB-shaped rows use snake_case to mirror the columns; the type-specific `data`
 * payloads inside a node use camelCase, matching the agenda feature's split
 * between DB rows and client view-models. `data` is stored as jsonb, so it
 * arrives as `unknown` and is narrowed per node type by the helpers below.
 */

export type NodeType = "text" | "flop" | "turn" | "river" | "strategy" | "action";

export const NODE_TYPES: NodeType[] = [
  "text",
  "flop",
  "turn",
  "river",
  "strategy",
  "action",
];

export const NODE_LABELS: Record<NodeType, string> = {
  text: "Text",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  strategy: "Strategy",
  action: "Action",
};

/** One spot / tree the user edits (e.g. "BTN vs BB SRP"). */
export type PokerSpot = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};

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
  | TextData
  | FlopData
  | StreetData
  | StrategyData
  | ActionData
  | Record<string, never>;

export type TextData = { title: string; body: string };
export type FlopData = { cards: string[] }; // up to 3 cards like "Ah"
export type StreetData = { card: string | null }; // turn / river
export type StrategyData = {
  label?: string;
  position?: "OOP" | "IP" | null;
  actions: StrategyAction[];
};
export type ActionData = {
  /** When the parent is a strategy node, which of its actions this represents. */
  strategyActionId?: string | null;
  kind: ActionKind;
  sizePct?: number | null;
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
  /** Sizing as a percentage of the pot, for bet/raise. */
  sizePct?: number | null;
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

export function asText(node: PokerNode): TextData {
  const d = node.data as Partial<TextData>;
  return { title: d.title ?? "", body: d.body ?? "" };
}

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
  return {
    label: d.label,
    position: d.position ?? null,
    actions: Array.isArray(d.actions) ? d.actions : [],
  };
}

export function asAction(node: PokerNode): ActionData {
  const d = node.data as Partial<ActionData>;
  return {
    strategyActionId: d.strategyActionId ?? null,
    kind: d.kind ?? "check",
    sizePct: d.sizePct ?? null,
    label: d.label ?? "Action",
    color: d.color ?? "#64748b",
  };
}
