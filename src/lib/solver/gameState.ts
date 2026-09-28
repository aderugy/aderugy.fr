/**
 * The state of the hand at every node of a spot's tree.
 *
 * A spot is a heads-up hand: its setup says who plays and where the tree
 * starts, and each node on a path changes the state — a decision says who
 * acts (it doesn't move chips), an action moves chips, a card node deals.
 * Walking a path from the root gives the pot, the stacks, whose turn it is,
 * whether the hand is over, and the first thing on the path that can't
 * happen in a real hand. The canvas, the server and the trainer all read the
 * hand through this file. Pure functions only.
 *
 * Conventions (the tree stores sizes, not chips):
 * - Preflop sizes are in bb and raise-to. Postflop sizes are % of the pot by
 *   default: a bet of p% puts p% of the pot (centre + bets in front) in; a
 *   raise of p% calls first, then adds p% of the pot after the call. A size
 *   marked `bb` postflop is the chips put in for a bet, raise-to for a raise.
 * - A bet or raise with no size, or labelled all-in / jam / shove, is all-in.
 *   Everything is capped at the stack.
 * - A bet facing a bet is read as a raise, a raise facing nothing as a bet:
 *   solver exports don't agree on the word. A check facing a bet and a call
 *   facing nothing are errors.
 * - Amounts stay exact (1.815, not 1.82) so a long line doesn't drift; only
 *   what is shown is rounded.
 */

import { POSTFLOP_ORDER, SEATS, type Seat } from "./seats";
import {
  asAction,
  asFlop,
  asOverride,
  asStreet,
  type ActionKind,
  type PokerNode,
  type SizeUnit,
  type SpotSetup,
  type StateOverride,
  type Street,
} from "./types";

export type Terminal =
  | { kind: "fold"; winner: Seat; potBb: number }
  | { kind: "showdown"; potBb: number }
  | { kind: "allin"; potBb: number };

export type LogEntry = {
  street: Street;
  seat: Seat;
  kind: ActionKind;
  label: string;
  /** What the seat has in front after the action (null for check / fold). */
  amountBb: number | null;
  allIn: boolean;
};

export type HandState = {
  players: [Seat, Seat];
  /** The street being bet, or the last one dealt. */
  street: Street;
  board: string[];
  /** Chips swept into the middle. */
  center: number;
  /** In front of each player this round. */
  bets: Record<string, number>;
  /** Behind. */
  stacks: Record<string, number>;
  /**
   * `betting`: `toAct` must decide. `deal`: the round is closed, `nextStreet`
   * must be dealt. `over`: the hand is finished, see `terminal`.
   */
  status: "betting" | "deal" | "over";
  toAct: Seat | null;
  nextStreet: Street | null;
  terminal: Terminal | null;
  /** Seats that acted since the last bet or raise this round. */
  acted: Seat[];
  /** Betting starts on this street; earlier streets are only dealt. */
  bettingFrom: Street;
  log: LogEntry[];
  /** A state override applies at or above this point. */
  manual: boolean;
};

export type ActionInput = {
  kind: ActionKind;
  sizePct: number | null;
  sizeUnit?: SizeUnit | null;
  label: string;
};

type Result = { ok: true; state: HandState } | { ok: false; error: string };

const STREET_ORDER: Street[] = ["preflop", "flop", "turn", "river"];
const BLINDS: Partial<Record<Seat, number>> = { SB: 0.5, BB: 1 };
const EPS = 1e-9;

export const round2 = (x: number) => Math.round(x * 100) / 100;

function nextOf(street: Street): Street | null {
  return STREET_ORDER[STREET_ORDER.indexOf(street) + 1] ?? null;
}

export function other(state: HandState, seat: Seat): Seat {
  return state.players[0] === seat ? state.players[1] : state.players[0];
}

/** Out of position postflop: the seat that acts first after the flop. */
export function oop(players: [Seat, Seat]): Seat {
  return POSTFLOP_ORDER.indexOf(players[0]) < POSTFLOP_ORDER.indexOf(players[1]) ? players[0] : players[1];
}

function preflopFirst(players: [Seat, Seat]): Seat {
  return SEATS.indexOf(players[0]) < SEATS.indexOf(players[1]) ? players[0] : players[1];
}

export function totalPot(s: HandState): number {
  return s.center + Object.values(s.bets).reduce((a, b) => a + b, 0);
}

function maxBet(s: HandState): number {
  return Math.max(0, ...Object.values(s.bets));
}

export function toCall(s: HandState, seat: Seat): number {
  return Math.max(0, maxBet(s) - (s.bets[seat] ?? 0));
}

/** The smaller stack behind. */
export function effectiveStack(s: HandState): number {
  return Math.min(...s.players.map((p) => s.stacks[p] ?? 0));
}

function clone(s: HandState): HandState {
  return { ...s, bets: { ...s.bets }, stacks: { ...s.stacks }, board: [...s.board], acted: [...s.acted], log: [...s.log] };
}

/* ------------------------------------------------------------------ start */

export function initialState(setup: SpotSetup & { players: [Seat, Seat] }): HandState {
  const players = setup.players;
  const base: HandState = {
    players,
    street: "preflop",
    board: [],
    center: 0,
    bets: { [players[0]]: 0, [players[1]]: 0 },
    stacks: { [players[0]]: setup.stackBb, [players[1]]: setup.stackBb },
    status: "betting",
    toAct: null,
    nextStreet: null,
    terminal: null,
    acted: [],
    bettingFrom: setup.street,
    log: [],
    manual: false,
  };

  if (setup.street === "preflop") {
    // Blinds are posted; a blind whose seat is not in the hand is dead money.
    for (const [seat, blind] of Object.entries(BLINDS) as [Seat, number][]) {
      if (players.includes(seat)) {
        base.bets[seat] = blind;
        base.stacks[seat] = setup.stackBb - blind;
      } else {
        base.center += blind;
      }
    }
    base.toAct = preflopFirst(players);
    return base;
  }

  // Later start: the pot is given, and the board is dealt before betting starts.
  base.center = setup.potBb ?? 0;
  base.status = "deal";
  base.nextStreet = "flop";
  return base;
}

/* ---------------------------------------------------------------- actions */

function isAllInLabel(label: string) {
  return /all.?in|jam|shove/i.test(label);
}

/** The street total `seat` would have in front after a bet / raise. */
function aggressiveTarget(s: HandState, seat: Seat, a: ActionInput): { to: number; allIn: boolean } {
  const already = s.bets[seat] ?? 0;
  const cap = already + (s.stacks[seat] ?? 0);
  const top = maxBet(s);
  const facing = top - already;
  let to: number;
  if (a.sizePct == null || isAllInLabel(a.label)) {
    to = cap;
  } else {
    const unit = a.sizeUnit ?? (s.street === "preflop" ? "bb" : "pct");
    if (unit === "bb") {
      const raiseTo = s.street === "preflop" || a.kind === "raise" || facing > EPS;
      to = raiseTo ? a.sizePct : already + a.sizePct;
    } else if (facing <= EPS) {
      to = already + (a.sizePct / 100) * totalPot(s);
    } else {
      to = top + (a.sizePct / 100) * (totalPot(s) + facing);
    }
  }
  const capped = Math.min(to, cap);
  return { to: capped, allIn: capped >= cap - EPS };
}

/**
 * What an action would put in front of `seat` — the amount a button shows —
 * without applying it. Null for check / fold.
 */
export function previewAction(s: HandState, seat: Seat, a: ActionInput): { to: number | null; put: number | null; allIn: boolean } {
  const already = s.bets[seat] ?? 0;
  if (a.kind === "check" || a.kind === "fold") return { to: null, put: null, allIn: false };
  if (a.kind === "call") {
    const to = Math.min(maxBet(s), already + (s.stacks[seat] ?? 0));
    return { to, put: to - already, allIn: to - already >= (s.stacks[seat] ?? 0) - EPS };
  }
  const { to, allIn } = aggressiveTarget(s, seat, a);
  return { to, put: to - already, allIn };
}

/** Close the round: sweep the bets in, then deal, or end the hand. */
function closeRound(s: HandState) {
  for (const p of s.players) {
    s.center = s.center + (s.bets[p] ?? 0);
    s.bets[p] = 0;
  }
  s.toAct = null;
  s.acted = [];
  const someoneAllIn = s.players.some((p) => (s.stacks[p] ?? 0) <= EPS);
  if (s.street === "river") {
    s.status = "over";
    s.terminal = { kind: "showdown", potBb: s.center };
  } else if (someoneAllIn) {
    s.status = "over";
    s.terminal = { kind: "allin", potBb: s.center };
  } else {
    s.status = "deal";
    s.nextStreet = nextOf(s.street);
  }
}

export function applyAction(state: HandState, a: ActionInput): Result {
  if (state.status === "over") return { ok: false, error: "The hand is over here." };
  if (state.status === "deal") return { ok: false, error: `The betting round is closed: deal the ${state.nextStreet} first.` };
  const seat = state.toAct as Seat;
  const s = clone(state);
  const already = s.bets[seat] ?? 0;
  const facing = toCall(s, seat);
  let kind = a.kind;
  if (kind === "bet" && facing > EPS) kind = "raise";
  if (kind === "raise" && facing <= EPS) kind = "bet";

  const entry = (amountBb: number | null, allIn: boolean): LogEntry => ({
    street: s.street,
    seat,
    kind,
    label: a.label,
    amountBb,
    allIn,
  });

  switch (kind) {
    case "fold": {
      s.log.push(entry(null, false));
      s.status = "over";
      s.toAct = null;
      const winner = other(s, seat);
      s.terminal = { kind: "fold", winner, potBb: totalPot(s) };
      return { ok: true, state: s };
    }
    case "check": {
      if (facing > EPS) return { ok: false, error: `${seat} can't check facing ${round2(facing)} bb.` };
      s.log.push(entry(null, false));
      s.acted.push(seat);
      break;
    }
    case "call": {
      if (facing <= EPS) return { ok: false, error: `${seat} has nothing to call here.` };
      const put = Math.min(facing, s.stacks[seat] ?? 0);
      s.bets[seat] = already + put;
      s.stacks[seat] = (s.stacks[seat] ?? 0) - put;
      s.log.push(entry(s.bets[seat], (s.stacks[seat] ?? 0) <= EPS));
      s.acted.push(seat);
      // A short all-in call leaves an uncalled excess: give it back.
      const opp = other(s, seat);
      const excess = (s.bets[opp] ?? 0) - s.bets[seat];
      if (excess > EPS) {
        s.bets[opp] = s.bets[seat];
        s.stacks[opp] = (s.stacks[opp] ?? 0) + excess;
      }
      break;
    }
    case "bet":
    case "raise": {
      if ((s.stacks[seat] ?? 0) <= EPS) return { ok: false, error: `${seat} is already all-in.` };
      const { to, allIn } = aggressiveTarget(s, seat, a);
      const top = maxBet(s);
      if (to <= top + EPS) {
        // Not even a full call (short stack): it is a call for less.
        return applyAction(state, { ...a, kind: "call" });
      }
      s.stacks[seat] = (s.stacks[seat] ?? 0) - (to - already);
      s.bets[seat] = to;
      s.log.push(entry(to, allIn));
      s.acted = [seat];
      break;
    }
  }

  const opp = other(s, seat);
  const even = Math.abs((s.bets[seat] ?? 0) - (s.bets[opp] ?? 0)) < EPS;
  const bothActed = s.acted.includes(seat) && s.acted.includes(opp);
  // Facing a bet with nothing behind, the other player has nothing left to decide.
  const oppStuck = (s.stacks[opp] ?? 0) <= EPS && (s.bets[opp] ?? 0) >= (s.bets[seat] ?? 0) - EPS;
  if (even && (bothActed || oppStuck)) {
    closeRound(s);
  } else {
    s.toAct = opp;
  }
  return { ok: true, state: s };
}

/* ------------------------------------------------------------------ cards */

export function dealCards(state: HandState, street: Street, cards: string[]): Result {
  if (state.status === "over") return { ok: false, error: "The hand is over: no card is dealt after this." };
  if (state.status === "betting") {
    return { ok: false, error: `The ${state.street} betting isn't finished: ${state.toAct} still has to act.` };
  }
  if (state.nextStreet !== street) {
    return { ok: false, error: `The next card is the ${state.nextStreet}, not the ${street}.` };
  }
  const need = street === "flop" ? 3 : 1;
  if (cards.length !== need) {
    return { ok: false, error: street === "flop" ? "The flop needs 3 cards." : `Pick the ${street} card.` };
  }
  const board = [...state.board, ...cards];
  if (new Set(board).size !== board.length) return { ok: false, error: "The same card appears twice on the board." };

  const s = clone(state);
  s.board = board;
  s.street = street;
  s.acted = [];
  s.nextStreet = null;
  if (STREET_ORDER.indexOf(street) < STREET_ORDER.indexOf(s.bettingFrom)) {
    s.status = "deal";
    s.nextStreet = nextOf(street);
    s.toAct = null;
  } else {
    s.status = "betting";
    s.toAct = oop(s.players);
  }
  return { ok: true, state: s };
}

/* -------------------------------------------------------------- overrides */

export function applyOverride(state: HandState, o: StateOverride): HandState {
  const s = clone(state);
  const inFront = Object.values(s.bets).reduce((a, b) => a + b, 0);
  s.center = Math.max(0, o.potBb - inFront);
  for (const p of s.players) s.stacks[p] = o.stackBb;
  s.manual = true;
  return s;
}

/* ------------------------------------------------------------------- walk */

export type NodeState = {
  /** The state after this node (for a decision: the state its player faces). */
  state: HandState;
  /** Who decides at a decision node. */
  actor: Seat | null;
  /** First problem at this node, or "the path above is invalid". */
  error: string | null;
  /** The state override on this node was used. */
  overridden: boolean;
};

export const INVALID_ABOVE = "The path above this node is invalid.";

/** The effect of one node on the state before it. */
export function stepNode(
  before: HandState,
  node: PokerNode,
  parent: PokerNode | null,
): { state: HandState; actor: Seat | null; error: string | null } {
  switch (node.type) {
    case "strategy": {
      if (before.status === "over") return { state: before, actor: null, error: "The hand is over: no one acts here." };
      if (before.status === "deal") {
        return { state: before, actor: null, error: `The betting round is closed: deal the ${before.nextStreet} first.` };
      }
      return { state: before, actor: before.toAct, error: null };
    }
    case "action": {
      if (!parent || parent.type !== "strategy") {
        return { state: before, actor: null, error: "An action must hang from a decision node." };
      }
      const a = asAction(node);
      const r = applyAction(before, { kind: a.kind, sizePct: a.sizePct ?? null, sizeUnit: a.sizeUnit, label: a.label });
      return r.ok ? { state: r.state, actor: before.toAct, error: null } : { state: before, actor: null, error: r.error };
    }
    case "flop":
    case "turn":
    case "river": {
      const cards = node.type === "flop" ? asFlop(node).cards : [asStreet(node).card].filter((c): c is string => !!c);
      const r = dealCards(before, node.type, cards);
      return r.ok ? { state: r.state, actor: null, error: null } : { state: before, actor: null, error: r.error };
    }
    default:
      return { state: before, actor: null, error: null };
  }
}

/** The state after `node`, given the state before it. */
export function nodeState(before: HandState, node: PokerNode, parent: PokerNode | null, broken: boolean): NodeState {
  if (broken) return { state: before, actor: null, error: INVALID_ABOVE, overridden: false };
  const step = stepNode(before, node, parent);
  if (step.error) return { state: before, actor: null, error: step.error, overridden: false };
  const o = asOverride(node);
  return { state: o ? applyOverride(step.state, o) : step.state, actor: step.actor, error: null, overridden: !!o };
}

/**
 * The state after every node of `path` (root → node). Once a node is
 * invalid, every node below it reports INVALID_ABOVE and keeps the last good
 * state, so the canvas can still show something.
 */
export function walkPath(setup: SpotSetup & { players: [Seat, Seat] }, path: PokerNode[]): NodeState[] {
  const out: NodeState[] = [];
  let state = initialState(setup);
  let broken = false;
  for (let i = 0; i < path.length; i++) {
    const ns = nodeState(state, path[i], path[i - 1] ?? null, broken);
    broken = broken || !!ns.error;
    state = ns.state;
    out.push(ns);
  }
  return out;
}

/** The state after every node reachable through `childrenOf`, from the roots (`null`) down. */
export function walkTree(
  setup: SpotSetup & { players: [Seat, Seat] },
  childrenOf: (id: string | null) => PokerNode[],
): Map<string, NodeState> {
  const out = new Map<string, NodeState>();
  const visit = (node: PokerNode, parent: PokerNode | null, before: HandState, broken: boolean) => {
    const ns = nodeState(before, node, parent, broken);
    out.set(node.id, ns);
    for (const kid of childrenOf(node.id)) visit(kid, node, ns.state, broken || !!ns.error);
  };
  const start = initialState(setup);
  for (const root of childrenOf(null)) visit(root, null, start, false);
  return out;
}

/** What can hang below a node in this state. */
export function childTypes(node: PokerNode | null, ns: NodeState | null, rootState: HandState): PokerNode["type"][] {
  if (node?.type === "strategy") return ns?.error ? [] : ["action"];
  if (ns?.error) return [];
  const s = ns?.state ?? rootState;
  if (s.status === "betting") return ["strategy"];
  if (s.status === "deal" && s.nextStreet && s.nextStreet !== "preflop") return [s.nextStreet];
  return [];
}

/** "BB check · BTN bet 1.82 · BB call" — a short log of the hand. */
export function logText(log: LogEntry[], fmt: (x: number) => string = (x) => String(round2(x))): string {
  return log
    .map((e) => {
      const verb = e.label.toLowerCase();
      return `${e.seat} ${verb}${e.amountBb != null && e.kind !== "call" ? ` (${fmt(e.amountBb)})` : ""}`;
    })
    .join(" · ");
}

/**
 * Options a new decision starts with: what a player usually has in this
 * state. Edited or replaced by a CSV import afterwards.
 */
export function defaultOptions(s: HandState): ActionInput[] {
  const seat = s.toAct;
  if (!seat) return [];
  const facing = toCall(s, seat) > EPS;
  if (s.street === "preflop") {
    return facing
      ? [
          { kind: "fold", sizePct: null, label: "Fold" },
          { kind: "call", sizePct: null, label: "Call" },
          { kind: "raise", sizePct: round2(Math.max(2.5, maxBet(s) * 3)), sizeUnit: "bb", label: `Raise ${round2(Math.max(2.5, maxBet(s) * 3))}bb` },
        ]
      : [
          { kind: "check", sizePct: null, label: "Check" },
          { kind: "raise", sizePct: 4, sizeUnit: "bb", label: "Raise 4bb" },
        ];
  }
  return facing
    ? [
        { kind: "fold", sizePct: null, label: "Fold" },
        { kind: "call", sizePct: null, label: "Call" },
        { kind: "raise", sizePct: 100, sizeUnit: "pct", label: "Raise 100%" },
      ]
    : [
        { kind: "check", sizePct: null, label: "Check" },
        { kind: "bet", sizePct: 33, sizeUnit: "pct", label: "Bet 33%" },
        { kind: "bet", sizePct: 75, sizeUnit: "pct", label: "Bet 75%" },
      ];
}

/** "Pot 5.5 · Eff. 97.5" style numbers: two decimals at most, no trailing zeros. */
export function fmtBb(x: number): string {
  const r = round2(x);
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0$/, "");
}
