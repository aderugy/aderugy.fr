/**
 * The table as hero sees it at the decision: seats, stacks, bets in front,
 * the pot, the action log and what each of hero's buttons costs.
 *
 * Conventions (the tree stores sizes, not chips):
 * - `stackBb` is the effective stack behind at the start of the street.
 * - Postflop, a bet of p% puts p% of the pot (centre + bets in front) in; a
 *   raise of p% calls first, then adds p% of the pot after the call.
 * - Preflop, sizes are raise-to amounts in bb (what the CSV headers carry,
 *   e.g. "RAISE 2.5bb"). Blinds are posted; the centre pot is whatever of
 *   `potBb` is not a blind in front of hero or villain (dead SB, antes).
 * - An aggressive action with no size is all-in. Everything is capped at the
 *   stack. Pure functions only.
 */

import { SEATS, type Seat } from "../solver/seats";
import type { ActionKind, StrategyAction } from "../solver/types";
import type { LineAction, Street } from "./types";

export type SceneSeat = {
  seat: Seat;
  role: "hero" | "villain" | "folded";
  /** Behind, after what is in front. */
  stack: number;
  /** In front this street. */
  bet: number;
  isButton: boolean;
};

export type SceneLine = { seat: Seat; label: string; amountBb: number | null };

export type SceneAction = {
  id: string;
  label: string;
  kind: ActionKind;
  color: string;
  /** Chips put in by this action (raise-to / bet / call amount), null for check / fold. */
  amountBb: number | null;
  allIn: boolean;
};

export type Scene = {
  street: Street;
  board: string[];
  seats: SceneSeat[];
  line: SceneLine[];
  /** Centre pot, not counting bets in front. */
  centerBb: number;
  /** Centre + every bet in front. */
  totalPotBb: number;
  toCallBb: number;
  actions: SceneAction[];
};

const BLINDS: Partial<Record<Seat, number>> = { SB: 0.5, BB: 1 };

const round2 = (x: number) => Math.round(x * 100) / 100;

function isAllInLabel(label: string) {
  return /all.?in|jam|shove/i.test(label);
}

type State = { center: number; bet: Record<string, number>; stack: Record<string, number> };

function potOf(s: State) {
  return s.center + Object.values(s.bet).reduce((a, b) => a + b, 0);
}

function maxBet(s: State) {
  return Math.max(0, ...Object.values(s.bet));
}

/** The street total `seat` would have in front after this action (null = no chips move). */
function targetBet(
  s: State,
  street: Street,
  seat: Seat,
  kind: ActionKind,
  sizePct: number | null,
  label: string,
): { to: number | null; allIn: boolean } {
  const already = s.bet[seat] ?? 0;
  const cap = already + (s.stack[seat] ?? 0);
  const clamp = (to: number) => {
    const capped = Math.min(to, cap);
    return { to: round2(capped), allIn: capped >= cap - 1e-9 };
  };
  switch (kind) {
    case "check":
    case "fold":
      return { to: null, allIn: false };
    case "call":
      return clamp(Math.max(already, maxBet(s)));
    case "bet":
    case "raise": {
      if (sizePct == null || isAllInLabel(label)) return { to: round2(cap), allIn: true };
      if (street === "preflop") return clamp(sizePct);
      const top = maxBet(s);
      if (kind === "bet" && top <= already) return clamp(already + (sizePct / 100) * potOf(s));
      const toCall = top - already;
      const potAfterCall = potOf(s) + toCall;
      return clamp(top + (sizePct / 100) * potAfterCall);
    }
  }
}

export function buildScene(input: {
  heroSeat: Seat;
  villainSeat: Seat;
  potBb: number;
  stackBb: number;
  street: Street;
  board: string[];
  line: LineAction[];
  heroActions: StrategyAction[];
}): Scene {
  const { heroSeat, villainSeat, street } = input;
  const players = [heroSeat, villainSeat];

  const state: State = { center: input.potBb, bet: {}, stack: {} };
  for (const p of players) {
    state.bet[p] = 0;
    state.stack[p] = input.stackBb;
  }
  if (street === "preflop") {
    for (const p of players) {
      const blind = BLINDS[p] ?? 0;
      state.bet[p] = blind;
      state.stack[p] = input.stackBb - blind;
      state.center -= blind;
    }
    state.center = Math.max(0, round2(state.center));
  }

  const line: SceneLine[] = [];
  for (const a of input.line) {
    if (!players.includes(a.seat)) continue;
    const { to } = targetBet(state, street, a.seat, a.kind, a.sizePct, a.label);
    if (to != null) {
      const add = Math.max(0, to - (state.bet[a.seat] ?? 0));
      state.stack[a.seat] = round2((state.stack[a.seat] ?? 0) - add);
      state.bet[a.seat] = to;
    }
    line.push({ seat: a.seat, label: a.label, amountBb: to });
  }

  const facing = maxBet(state);
  const heroIn = state.bet[heroSeat] ?? 0;
  const toCall = round2(Math.max(0, facing - heroIn));
  const potNow = potOf(state);

  const actions: SceneAction[] = input.heroActions.map((a) => {
    const { to, allIn } = targetBet(state, street, heroSeat, a.kind, a.sizePct ?? null, a.label);
    const aggressive = a.kind === "bet" || a.kind === "raise";
    const put = to == null ? null : round2(to - heroIn);
    return {
      id: a.id,
      label: a.label,
      kind: a.kind,
      color: a.color,
      amountBb: a.kind === "call" ? put : to,
      allIn: aggressive && allIn,
    };
  });

  const seats: SceneSeat[] = SEATS.map((seat) => ({
    seat,
    role: seat === heroSeat ? "hero" : seat === villainSeat ? "villain" : "folded",
    stack: players.includes(seat) ? round2(state.stack[seat] ?? 0) : input.stackBb,
    bet: players.includes(seat) ? round2(state.bet[seat] ?? 0) : 0,
    isButton: seat === "BTN",
  }));

  return {
    street,
    board: input.board,
    seats,
    line,
    centerBb: round2(state.center),
    totalPotBb: round2(potNow),
    toCallBb: toCall,
    actions,
  };
}

/** Seats in clockwise order starting from hero, so hero can sit at the bottom. */
export function seatsFromHero(heroSeat: Seat): Seat[] {
  const i = SEATS.indexOf(heroSeat);
  return [...SEATS.slice(i), ...SEATS.slice(0, i)];
}
