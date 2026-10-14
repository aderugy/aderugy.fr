/**
 * The rules of a no-limit hold'em hand, for entering a live hand action by
 * action and replaying it. Pure functions, no DOM, no database.
 *
 * Seats are table seat numbers (1–10). Action goes clockwise, which at a
 * casino table is increasing seat number (seat 1 sits on the dealer's left),
 * wrapping from the last seat to seat 1. Amounts are chips in the session's
 * currency. A stack is optional: when it is not known, a player is all-in
 * only when the action says so.
 *
 * What is enforced: turn order, check only when nothing is owed, bet only on
 * an unopened street, a raise at least the last full raise (unless all-in),
 * no more than the stack when it is known, and blinds bought back (a live
 * post that counts as a bet, a dead one that goes to the pot). What is not:
 * string bets, a dead button's dead small blind — they are notes, not rules.
 */

import type { ActionKind, HandAction, HandPost, HandSeat, Street } from "./types";
import { STREETS } from "./types";

export type HandSetup = {
  seats: HandSeat[];
  /** The button's seat. It need not be dealt in (a dead button). */
  button: number;
  sb: number;
  bb: number;
  straddle?: number | null;
  /** Blinds bought back by players returning after missing them. */
  posts?: HandPost[];
};

export type SeatState = {
  seat: number;
  stack: number | null;
  /** Put in over the whole hand. */
  committed: number;
  /** Put in on the current street. */
  street: number;
  /** Of `committed`, what went in dead (a small blind bought back): pot money, never a bet. */
  dead: number;
  folded: boolean;
  allIn: boolean;
  /** Has acted since the last full bet or raise on this street. */
  acted: boolean;
};

export type HandEnd =
  | { reason: "fold"; winner: number }
  /** `runout`: the board was dealt with no more betting possible (all-in). */
  | { reason: "showdown"; runout: boolean };

export type HandState = {
  street: Street;
  /** Collected from finished streets; this street's bets are on the seats. */
  pot: number;
  currentBet: number;
  /** Size of the last full bet or raise on this street: the minimum raise. */
  lastRaise: number;
  toAct: number | null;
  end: HandEnd | null;
  /** Clockwise from the first seat after the button. */
  seats: SeatState[];
  sbSeat: number;
  bbSeat: number;
  straddleSeat: number | null;
  bb: number;
  /** Dead money posted before the cards (blinds bought back), already in `pot`. */
  dead: number;
};

/** What one entered action did, for the replay and the written line. */
export type Step = {
  action: HandAction;
  street: Street;
  /** Chips this action put in. */
  added: number;
  /** The seat's street total after it (the "to" of a call, too). */
  to: number;
  allIn: boolean;
  state: HandState;
};

export type PlayResult = {
  ok: boolean;
  /** Set when an action could not be applied. */
  error: string | null;
  /** Index of the action that failed. */
  failedAt: number | null;
  /** State after the blinds, then after each applied action. */
  start: HandState;
  steps: Step[];
  /** The last good state. */
  state: HandState;
};

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Seat numbers clockwise starting from the first one after `button`. */
export function clockwiseFrom(button: number, seats: number[]): number[] {
  const sorted = [...seats].sort((a, b) => a - b);
  const after = sorted.filter((s) => s > button);
  const before = sorted.filter((s) => s <= button);
  return [...after, ...before];
}

/** The seat that follows `seat` clockwise among `order` (which must contain it). */
function nextIn(order: number[], seat: number): number {
  const i = order.indexOf(seat);
  return order[(i + 1) % order.length];
}

function cloneState(s: HandState): HandState {
  return { ...s, end: s.end ? { ...s.end } : null, seats: s.seats.map((x) => ({ ...x })) };
}

function seatOf(state: HandState, seat: number): SeatState {
  const s = state.seats.find((x) => x.seat === seat);
  if (!s) throw new Error(`Seat ${seat} is not in the hand.`);
  return s;
}

/** Chips left behind, or null when the stack is not known. */
export function behind(s: SeatState): number | null {
  return s.stack === null ? null : r2(s.stack - s.committed);
}

function put(s: SeatState, amount: number): number {
  const left = behind(s);
  const added = left === null ? amount : Math.min(amount, left);
  s.committed = r2(s.committed + added);
  s.street = r2(s.street + added);
  if (left !== null && added >= left) s.allIn = true;
  return added;
}

/** Validate the setup and post the blinds. Throws a sentence. */
export function startHand(setup: HandSetup): HandState {
  const nums = setup.seats.map((s) => s.seat);
  if (nums.length < 2) throw new Error("A hand needs at least two players.");
  if (new Set(nums).size !== nums.length) throw new Error("A seat is dealt in twice.");
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 10)) throw new Error("Seats are numbered 1 to 10.");
  if (!(setup.sb > 0) || !(setup.bb >= setup.sb)) throw new Error("The big blind must be at least the small blind.");
  if (setup.straddle != null && !(setup.straddle > setup.bb)) throw new Error("A straddle must be more than the big blind.");
  for (const s of setup.seats) {
    if (s.stack !== null && !(s.stack > 0)) throw new Error(`Seat ${s.seat}: a stack must be positive.`);
  }

  const order = clockwiseFrom(setup.button, nums);
  const headsUp = order.length === 2;
  // Heads-up the button posts the small blind and acts first preflop.
  const buttonIn = nums.includes(setup.button);
  const sbSeat = headsUp && buttonIn ? setup.button : order[0];
  const bbSeat = nextIn(order, sbSeat);
  const straddleSeat = setup.straddle != null && !headsUp ? nextIn(order, bbSeat) : null;
  if (straddleSeat === sbSeat) throw new Error("A straddle needs at least three players.");

  const state: HandState = {
    street: "preflop",
    pot: 0,
    currentBet: 0,
    lastRaise: setup.bb,
    toAct: null,
    end: null,
    seats: order.map((n) => {
      const s = setup.seats.find((x) => x.seat === n)!;
      return { seat: n, stack: s.stack ?? null, committed: 0, street: 0, dead: 0, folded: false, allIn: false, acted: false };
    }),
    sbSeat,
    bbSeat,
    straddleSeat,
    bb: setup.bb,
    dead: 0,
  };
  put(seatOf(state, sbSeat), setup.sb);
  put(seatOf(state, bbSeat), setup.bb);
  if (straddleSeat !== null) put(seatOf(state, straddleSeat), setup.straddle!);
  for (const p of checkPosts(setup.posts ?? [], nums, [sbSeat, bbSeat, straddleSeat], setup.bb)) {
    const s = seatOf(state, p.seat);
    if (p.live > 0) put(s, p.live);
    if (p.dead > 0) {
      const left = behind(s);
      const dead = left === null ? p.dead : Math.min(p.dead, left);
      s.committed = r2(s.committed + dead);
      s.dead = r2(s.dead + dead);
      if (left !== null && dead >= left) s.allIn = true;
      state.dead = r2(state.dead + dead);
      state.pot = r2(state.pot + dead);
    }
  }
  state.currentBet = Math.max(...state.seats.map((s) => s.street));
  if (straddleSeat !== null) state.lastRaise = setup.straddle!;

  state.toAct = nextToAct(state, straddleSeat ?? bbSeat);
  if (state.toAct === null) closeStreet(state);
  return state;
}

/**
 * Blinds bought back, checked: a seat dealt in, not already in a blind, once
 * each; a live post at most the big blind (it is one), a dead one at most the
 * big blind too. Throws a sentence.
 */
function checkPosts(posts: HandPost[], dealt: number[], blinds: (number | null)[], bb: number): HandPost[] {
  const seen = new Set<number>();
  for (const p of posts) {
    if (!dealt.includes(p.seat)) throw new Error(`Seat ${p.seat} posts but is not dealt in.`);
    if (blinds.includes(p.seat)) throw new Error(`Seat ${p.seat} is already in a blind: it does not post another.`);
    if (seen.has(p.seat)) throw new Error(`Seat ${p.seat} posts twice.`);
    seen.add(p.seat);
    if (!(p.live >= 0) || !(p.dead >= 0) || !(p.live + p.dead > 0)) throw new Error(`Seat ${p.seat}: a post is a positive amount.`);
    if (p.live > bb) throw new Error(`Seat ${p.seat}: a live post is at most the big blind.`);
    if (p.dead > bb) throw new Error(`Seat ${p.seat}: a dead post is at most the big blind.`);
  }
  return posts;
}

/** "posts 2", "posts 2 + 1 dead", "posts 1 dead" */
export function describePost(p: HandPost): string {
  if (p.live > 0 && p.dead > 0) return `posts ${fmt(p.live)} + ${fmt(p.dead)} dead`;
  if (p.live > 0) return `posts ${fmt(p.live)}`;
  return `posts ${fmt(p.dead)} dead`;
}

function owes(state: HandState, s: SeatState): number {
  return r2(state.currentBet - s.street);
}

function canAct(state: HandState, s: SeatState): boolean {
  return !s.folded && !s.allIn && (!s.acted || owes(state, s) > 0);
}

/** First seat after `from`, clockwise, that still has to act on this street. */
function nextToAct(state: HandState, from: number): number | null {
  const order = state.seats.map((s) => s.seat);
  let seat = from;
  for (let i = 0; i < order.length; i++) {
    seat = order.includes(seat) ? nextIn(order, seat) : order[0];
    const s = seatOf(state, seat);
    if (canAct(state, s)) return seat;
  }
  return null;
}

function inHand(state: HandState): SeatState[] {
  return state.seats.filter((s) => !s.folded);
}

function closeStreet(state: HandState) {
  state.pot = r2(state.pot + state.seats.reduce((t, s) => t + s.street, 0));
  for (const s of state.seats) {
    s.street = 0;
    s.acted = false;
  }
  state.currentBet = 0;
  state.lastRaise = state.bb;
  state.toAct = null;

  const live = inHand(state);
  const withChips = live.filter((s) => !s.allIn);
  const i = STREETS.indexOf(state.street);
  if (i === STREETS.length - 1) {
    state.end = { reason: "showdown", runout: false };
    return;
  }
  if (withChips.length <= 1) {
    // Nobody left to bet against: the rest of the board is just dealt.
    state.street = "river";
    state.end = { reason: "showdown", runout: true };
    return;
  }
  state.street = STREETS[i + 1];
  // Postflop the first seat after the button still in with chips opens.
  state.toAct = withChips[0].seat;
}

/** Apply one action. Returns the new state and what it did; throws a sentence. */
export function applyAction(prev: HandState, action: HandAction): { state: HandState; step: Step } {
  if (prev.end) throw new Error("The hand is over.");
  if (prev.toAct === null) throw new Error("Nobody is left to act.");
  if (action.seat !== prev.toAct) throw new Error(`Seat ${prev.toAct} acts now, not seat ${action.seat}.`);

  const state = cloneState(prev);
  const s = seatOf(state, action.seat);
  const street = state.street;
  const toCall = owes(state, s);
  const left = behind(s);
  let added = 0;

  switch (action.kind) {
    case "fold":
      s.folded = true;
      break;
    case "check":
      if (toCall > 0) throw new Error(`Seat ${s.seat} cannot check: ${toCall} to call.`);
      break;
    case "call":
      if (toCall <= 0) throw new Error(`Seat ${s.seat} has nothing to call.`);
      added = put(s, toCall);
      if (action.all_in) s.allIn = true;
      break;
    case "bet":
    case "raise": {
      const to = r2(Number(action.to));
      if (!(to > 0)) throw new Error(`Seat ${s.seat}: give the amount to ${action.kind} to.`);
      if (action.kind === "bet" && state.currentBet > 0) throw new Error(`Seat ${s.seat} faces a bet: that is a raise.`);
      if (action.kind === "raise" && state.currentBet === 0) throw new Error(`Nobody has bet: seat ${s.seat} bets.`);
      if (to <= state.currentBet) throw new Error(`Seat ${s.seat}: ${to} is not more than the ${state.currentBet} already bet.`);
      const need = r2(to - s.street);
      if (left !== null && need > left) throw new Error(`Seat ${s.seat} has only ${r2(left + s.street)} on this street.`);
      const allIn = Boolean(action.all_in) || (left !== null && need === left);
      const minTo = state.currentBet === 0 ? state.bb : r2(state.currentBet + state.lastRaise);
      if (to < minTo && !allIn) {
        throw new Error(`Seat ${s.seat}: the minimum ${action.kind} is to ${minTo}.`);
      }
      added = put(s, need);
      if (allIn) s.allIn = true;
      const raiseBy = r2(to - state.currentBet);
      if (raiseBy >= state.lastRaise) {
        state.lastRaise = raiseBy;
      }
      state.currentBet = to;
      // Everyone else must answer the new amount.
      for (const o of state.seats) if (o !== s) o.acted = false;
      break;
    }
    default:
      throw new Error(`Unknown action "${(action as { kind: string }).kind}".`);
  }
  s.acted = true;
  const toAfter = s.street;

  const live = inHand(state);
  if (live.length === 1) {
    state.end = { reason: "fold", winner: live[0].seat };
    state.toAct = null;
    // The winner's unmatched bet goes back to them; the pot shows what was won.
    state.pot = r2(state.pot + state.seats.reduce((t, x) => t + x.street, 0));
    for (const x of state.seats) x.street = 0;
  } else {
    state.toAct = nextToAct(state, s.seat);
    if (state.toAct === null) closeStreet(state);
  }

  return {
    state,
    step: { action, street, added, to: toAfter, allIn: s.allIn, state },
  };
}

/** Replay a whole action list, stopping at the first action that does not fit. */
export function playHand(setup: HandSetup, actions: HandAction[]): PlayResult {
  const start = startHand(setup);
  const steps: Step[] = [];
  let state = start;
  for (let i = 0; i < actions.length; i++) {
    try {
      const r = applyAction(state, actions[i]);
      steps.push(r.step);
      state = r.state;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), failedAt: i, start, steps, state };
    }
  }
  return { ok: true, error: null, failedAt: null, start, steps, state };
}

/* --------------------------------------------------------------- options */

export type Options = {
  seat: number;
  toCall: number;
  /** Chips behind, or null when the stack is not known. */
  behind: number | null;
  canCheck: boolean;
  canCall: boolean;
  /** The amount a call puts in (less than toCall when it is an all-in call). */
  callAmount: number;
  /** "bet" on an unopened street, "raise" otherwise; null when not possible. */
  aggressive: "bet" | "raise" | null;
  minTo: number;
  maxTo: number | null;
  pot: number;
};

/** What the seat to act may do. Null when nobody is to act. */
export function options(state: HandState): Options | null {
  if (state.toAct === null || state.end) return null;
  const s = seatOf(state, state.toAct);
  const toCall = owes(state, s);
  const left = behind(s);
  const pot = r2(state.pot + state.seats.reduce((t, x) => t + x.street, 0));
  const maxTo = left === null ? null : r2(s.street + left);
  const minTo = state.currentBet === 0 ? state.bb : r2(state.currentBet + state.lastRaise);
  const canRaise = left === null || left > toCall;
  // Raising is closed to a seat that already acted when the last raise was
  // short (an incomplete all-in): it may only call or fold. Kept lenient —
  // the action could have been reopened by a full raise we cannot see.
  return {
    seat: s.seat,
    toCall,
    behind: left,
    canCheck: toCall === 0,
    canCall: toCall > 0,
    callAmount: left === null ? toCall : Math.min(toCall, left),
    aggressive: canRaise ? (state.currentBet === 0 ? "bet" : "raise") : null,
    minTo: maxTo !== null ? Math.min(minTo, maxTo) : minTo,
    maxTo,
    pot,
  };
}

/**
 * Fold every seat that acts before `target` on this street, so a tap on the
 * seat that does something skips the folds in between. Null when `target`
 * will not get to act before the street ends.
 */
export function foldsUntil(state: HandState, target: number): HandAction[] | null {
  const out: HandAction[] = [];
  let s = state;
  while (s.toAct !== null && s.toAct !== target) {
    const a: HandAction = { seat: s.toAct, kind: "fold" };
    try {
      s = applyAction(s, a).state;
    } catch {
      return null;
    }
    out.push(a);
    if (s.end || s.street !== state.street) return null;
  }
  return s.toAct === target ? out : null;
}

/** A pot-sized raise: call, then raise by the pot after the call. */
export function potRaiseTo(state: HandState): number {
  const o = options(state);
  if (!o) return 0;
  return r2(state.currentBet + o.pot + o.toCall);
}

/* ------------------------------------------------------------- positions */

const MIDDLE: Record<number, string[]> = {
  1: ["UTG"],
  2: ["UTG", "CO"],
  3: ["UTG", "HJ", "CO"],
  4: ["UTG", "LJ", "HJ", "CO"],
  5: ["UTG", "UTG+1", "LJ", "HJ", "CO"],
  6: ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO"],
  7: ["UTG", "UTG+1", "UTG+2", "MP", "LJ", "HJ", "CO"],
};

/** Position names for the seats dealt in: SB, BB, UTG… CO, BTN. */
export function positions(seats: number[], button: number): Map<number, string> {
  const order = clockwiseFrom(button, seats);
  const out = new Map<number, string>();
  const buttonIn = seats.includes(button);
  if (order.length === 2) {
    const other = order.find((s) => s !== button) ?? order[1];
    if (buttonIn) out.set(button, "BTN");
    else out.set(order[0], "SB");
    out.set(buttonIn ? other : order[1], "BB");
    return out;
  }
  out.set(order[0], "SB");
  out.set(order[1], "BB");
  const rest = order.slice(2, buttonIn ? -1 : undefined);
  if (buttonIn) out.set(button, "BTN");
  const names = MIDDLE[rest.length] ?? rest.map((_, i) => `UTG+${i}`);
  rest.forEach((s, i) => out.set(s, names[i] ?? `MP${i}`));
  return out;
}

/* ---------------------------------------------------------------- result */

export type Pot = {
  amount: number;
  /** Seats still in the hand that put in enough to win it. */
  eligible: number[];
  /** Who takes it: the winners eligible for it, or its only eligible seat. Empty when unknown. */
  takers: number[];
};

export type Settlement = {
  pots: Pot[];
  /** The part of the last bet nobody called, returned to who made it. */
  refund: { seat: number; amount: number } | null;
  /** Net per seat over the hand, for the pots whose winner is known. */
  net: Map<number, number>;
  total: number;
};

/**
 * Split what was put in into the main pot and side pots, and give each pot to
 * the seats `winners` names for it (main pot first; several seats split it
 * evenly, odd chips not modelled). A pot with a single eligible seat goes to
 * it whatever `winners` says, and so does everything in a hand won without
 * showdown. A pot nobody is named for stays unassigned.
 */
export function settle(state: HandState, winners: number[][] = []): Settlement {
  // Bets make the pots; dead money (blinds bought back) joins the main pot.
  const contrib = new Map(state.seats.map((s) => [s.seat, r2(s.committed - (s.dead ?? 0))]));
  const deadOf = new Map(state.seats.map((s) => [s.seat, s.dead ?? 0]));
  const dead = r2(state.seats.reduce((t, s) => t + (s.dead ?? 0), 0));
  const live = state.seats.filter((s) => !s.folded).map((s) => s.seat);

  // Uncalled: the top contributor gets back what nobody else matched.
  const sorted = [...contrib.entries()].sort((a, b) => b[1] - a[1]);
  let refund: Settlement["refund"] = null;
  if (sorted.length > 1 && sorted[0][1] > sorted[1][1]) {
    const amount = r2(sorted[0][1] - sorted[1][1]);
    refund = { seat: sorted[0][0], amount };
    contrib.set(sorted[0][0], sorted[1][1]);
  }

  const levels = [...new Set(live.map((s) => contrib.get(s)!))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const c of contrib.values()) amount += Math.max(0, Math.min(c, level) - prev);
    const eligible = live.filter((s) => contrib.get(s)! >= level);
    if (amount > 0) pots.push({ amount: r2(amount), eligible, takers: [] });
    prev = level;
  }
  // Chips a folded seat put in above every live seat's level join the last pot.
  let extra = 0;
  for (const c of contrib.values()) extra += Math.max(0, c - prev);
  if (extra > 0 && pots.length) pots[pots.length - 1].amount = r2(pots[pots.length - 1].amount + extra);
  if (dead > 0) {
    if (pots.length) pots[0].amount = r2(pots[0].amount + dead);
    else pots.push({ amount: dead, eligible: live, takers: [] });
  }

  pots.forEach((p, i) => {
    const named = (winners[i] ?? []).filter((s) => p.eligible.includes(s));
    p.takers = p.eligible.length === 1 ? [...p.eligible] : named;
  });

  const net = new Map<number, number>();
  for (const [seat, c] of contrib) net.set(seat, -r2(c + (deadOf.get(seat) ?? 0)));
  for (const p of pots) {
    for (const t of p.takers) net.set(t, r2((net.get(t) ?? 0) + p.amount / p.takers.length));
  }
  const total = r2(pots.reduce((t, p) => t + p.amount, 0));
  return { pots, refund, net, total };
}

/** Whether every pot has a taker. */
export function settled(s: Settlement): boolean {
  return s.pots.every((p) => p.takers.length > 0);
}

/* ------------------------------------------------------------ the record */

export const ACTION_VERBS: Record<ActionKind, string> = {
  fold: "folds",
  check: "checks",
  call: "calls",
  bet: "bets",
  raise: "raises to",
};

/** "raises to 15", "calls 10 (all-in)", "folds" */
export function describeStep(step: Step): string {
  const { action } = step;
  let text: string;
  switch (action.kind) {
    case "call":
      text = `calls ${fmt(step.added)}`;
      break;
    case "bet":
      text = `bets ${fmt(step.to)}`;
      break;
    case "raise":
      text = `raises to ${fmt(step.to)}`;
      break;
    default:
      text = ACTION_VERBS[action.kind];
  }
  return step.allIn && action.kind !== "fold" && action.kind !== "check" ? `${text} (all-in)` : text;
}

function fmt(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0$/, "");
}

/** The actions grouped by street, for the written line of a hand. */
export function stepsByStreet(steps: Step[]): { street: Street; steps: Step[] }[] {
  const out: { street: Street; steps: Step[] }[] = [];
  for (const step of steps) {
    const last = out[out.length - 1];
    if (last && last.street === step.street) last.steps.push(step);
    else out.push({ street: step.street, steps: [step] });
  }
  return out;
}
