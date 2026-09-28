/**
 * The table as hero sees it at a decision: seats, stacks, bets in front, the
 * pot, the action log and what each of hero's buttons costs. Built from the
 * hand's state (`gameState.ts`), which holds every betting convention; this
 * file only lays it out. Pure functions only.
 */

import { SEATS, type Seat } from "../solver/seats";
import { previewAction, totalPot, toCall, type HandState } from "../solver/gameState";
import type { ActionKind, StrategyAction, Street } from "../solver/types";

export type SceneSeat = {
  seat: Seat;
  role: "hero" | "villain" | "folded";
  /** Behind, after what is in front. */
  stack: number;
  /** In front this street. */
  bet: number;
  isButton: boolean;
};

export type SceneLine = { seat: Seat; label: string; amountBb: number | null; street: Street };

export type SceneAction = {
  id: string;
  label: string;
  kind: ActionKind;
  color: string;
  /** Chips put in by this action (raise-to / bet total, or the call amount), null for check / fold. */
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

export function sceneFromState(input: {
  state: HandState;
  heroSeat: Seat;
  villainSeat: Seat;
  /** Shown for the seats that are not in the hand. */
  stackBb: number;
  /** Hero's options at this decision (none between decisions). */
  heroActions: StrategyAction[];
}): Scene {
  const { state, heroSeat, villainSeat } = input;
  const players: Seat[] = [heroSeat, villainSeat];
  const actions: SceneAction[] = input.heroActions.map((a) => {
    const p = previewAction(state, heroSeat, { kind: a.kind, sizePct: a.sizePct ?? null, sizeUnit: a.sizeUnit, label: a.label });
    return {
      id: a.id,
      label: a.label,
      kind: a.kind,
      color: a.color,
      amountBb: a.kind === "call" ? p.put : p.to,
      allIn: (a.kind === "bet" || a.kind === "raise") && p.allIn,
    };
  });
  const seats: SceneSeat[] = SEATS.map((seat) => ({
    seat,
    role: seat === heroSeat ? "hero" : seat === villainSeat ? "villain" : "folded",
    stack: players.includes(seat) ? (state.stacks[seat] ?? 0) : input.stackBb,
    bet: players.includes(seat) ? (state.bets[seat] ?? 0) : 0,
    isButton: seat === "BTN",
  }));
  return {
    street: state.street,
    board: state.board,
    seats,
    line: state.log.map((e) => ({ seat: e.seat, label: e.label, amountBb: e.amountBb, street: e.street })),
    centerBb: state.center,
    totalPotBb: totalPot(state),
    toCallBb: toCall(state, heroSeat),
    actions,
  };
}

/** Seats in clockwise order starting from hero, so hero can sit at the bottom. */
export function seatsFromHero(heroSeat: Seat): Seat[] {
  const i = SEATS.indexOf(heroSeat);
  return [...SEATS.slice(i), ...SEATS.slice(0, i)];
}
