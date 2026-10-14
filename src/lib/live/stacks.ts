/**
 * What each seat has in front of it during a session: `live_sessions.stacks`,
 * seat number → chips. Pure functions; the server applies them when the table
 * changes and when a hand is saved.
 */

import { settled, type Settlement } from "./hand";
import type { HandSeat } from "./types";

export type Stacks = Record<string, number>;

const r2 = (x: number) => Math.round(x * 100) / 100;

/** The stack of a seat, or null when not known. */
export function stackOf(stacks: Stacks | null | undefined, seat: number): number | null {
  const v = stacks?.[String(seat)];
  return typeof v === "number" && v > 0 ? v : null;
}

/** Set (or clear, with null) one seat's stack. */
export function withStack(stacks: Stacks, seat: number, value: number | null): Stacks {
  const next = { ...stacks };
  if (value === null || !(value > 0)) delete next[String(seat)];
  else next[String(seat)] = r2(value);
  return next;
}

/** A player changes seat: their stack goes with them. */
export function moveStack(stacks: Stacks, from: number, to: number): Stacks {
  const v = stackOf(stacks, from);
  return withStack(withStack(stacks, from, null), to, v);
}

/** A rebuy: added to the stack when it is known, else the stack becomes the rebuy. */
export function addToStack(stacks: Stacks, seat: number, amount: number): Stacks {
  return withStack(stacks, seat, r2((stackOf(stacks, seat) ?? 0) + amount));
}

/**
 * After a hand: each seat dealt in with a known stack ends with that stack
 * plus what it won or lost. Only when every pot has a taker — otherwise what
 * a seat won is not known and the stacks are left as they were. A seat left
 * with nothing is cleared (busted). Seats whose stack was not given keep
 * whatever the table had.
 */
export function stacksAfterHand(stacks: Stacks, seats: HandSeat[], settlement: Settlement): Stacks {
  if (!settled(settlement)) return stacks;
  let next = { ...stacks };
  for (const s of seats) {
    if (s.stack == null) continue;
    const net = settlement.net.get(s.seat) ?? 0;
    next = withStack(next, s.seat, r2(s.stack + net));
  }
  return next;
}
