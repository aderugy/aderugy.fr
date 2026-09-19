/**
 * 6-max seats and who acts first. Pure functions only.
 *
 * A strategy node names who plays it (`seat`) and against whom (`vsSeat`).
 * IP / OOP is derived from the two: postflop, the later seat in
 * SB → BB → UTG → HJ → CO → BTN is in position.
 */

export type Seat = "UTG" | "HJ" | "CO" | "BTN" | "SB" | "BB";

/** Preflop action order. */
export const SEATS: Seat[] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];

/** Postflop action order: the blinds act first. */
export const POSTFLOP_ORDER: Seat[] = ["SB", "BB", "UTG", "HJ", "CO", "BTN"];

export function isSeat(value: unknown): value is Seat {
  return typeof value === "string" && (SEATS as string[]).includes(value);
}

/** Is `seat` in position against `vs` (postflop)? */
export function isInPosition(seat: Seat, vs: Seat): boolean {
  return POSTFLOP_ORDER.indexOf(seat) > POSTFLOP_ORDER.indexOf(vs);
}

/** The IP / OOP label implied by two seats, or null when they are incomplete or equal. */
export function derivedPosition(
  seat: Seat | null | undefined,
  vs: Seat | null | undefined,
): "IP" | "OOP" | null {
  if (!seat || !vs || seat === vs) return null;
  return isInPosition(seat, vs) ? "IP" : "OOP";
}

/** Which of the two seats acts first on a street. */
export function firstToAct(street: "preflop" | "flop" | "turn" | "river", a: Seat, b: Seat): Seat {
  const order = street === "preflop" ? SEATS : POSTFLOP_ORDER;
  return order.indexOf(a) < order.indexOf(b) ? a : b;
}

/** "BTN vs BB", or null when a seat is missing. */
export function matchupLabel(seat: Seat | null | undefined, vs: Seat | null | undefined): string | null {
  return seat && vs ? `${seat} vs ${vs}` : null;
}
