/**
 * Pot odds for the seat facing a bet, with the room's rake taken out of the
 * pot it would win. Pure functions.
 *
 *   to call   = what the seat owes (capped at its stack; the bettor's excess
 *               then goes back and is in no pot)
 *   pot after = the pot now, every bet on the street included, + the call
 *   rake      = the room's share of that pot (rakeOn, as if it is raked)
 *   net pot   = pot after − rake: what the winner takes home
 *   need      = to call ÷ net pot — the equity the call must have
 *   odds      = (net pot − to call) : to call
 *
 * It assumes no more money goes in after the call, so it is the price of the
 * call, not implied odds.
 */

import { behind, type HandState } from "./hand";
import { rakeOn, type RakeRule } from "./rake";

export type FacingOdds = {
  seat: number;
  toCall: number;
  potAfter: number;
  rake: number;
  netPot: number;
  /** Equity the call needs, 0..1. */
  need: number;
  /** x in "x : 1". */
  ratio: number;
};

const r2 = (x: number) => Math.round(x * 100) / 100;

export function facingOdds(state: HandState, rake: RakeRule | null): FacingOdds | null {
  if (state.end || state.toAct === null) return null;
  const s = state.seats.find((x) => x.seat === state.toAct);
  if (!s) return null;
  const owes = r2(state.currentBet - s.street);
  if (!(owes > 0)) return null;
  const left = behind(s);
  const toCall = left !== null ? Math.min(owes, left) : owes;
  const now = r2(state.pot + state.seats.reduce((t, x) => t + x.street, 0));
  // A short call leaves part of the bet unmatched: it goes back to the bettor.
  const potAfter = r2(now + toCall - (owes - toCall));
  const taken = rake ? rakeOn(potAfter, rake, true) : 0;
  const netPot = r2(potAfter - taken);
  if (!(netPot > 0) || !(toCall > 0)) return null;
  return { seat: s.seat, toCall: r2(toCall), potAfter, rake: taken, netPot, need: toCall / netPot, ratio: (netPot - toCall) / toCall };
}
