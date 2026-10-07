/**
 * Checking a hand before it is saved, shared by the editor (to say what is
 * missing) and the server (to refuse what the editor should not have sent).
 */

import { BOARD_SIZE, CARD_RE, LIVE_LIMITS, splitCards, type HandInput } from "./types";
import { playHand, settle, type PlayResult, type Settlement } from "./hand";

export type CheckedHand = { input: HandInput; play: PlayResult; settlement: Settlement };

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Normalise and check a hand; throws a sentence. */
export function checkHand(raw: HandInput, tableSize: number): CheckedHand {
  const seats = (raw.seats ?? []).map((s) => ({
    seat: Number(s.seat),
    player_id: s.player_id ?? null,
    stack: s.stack == null || (s.stack as unknown) === "" ? null : r2(Number(s.stack)),
  }));
  for (const s of seats) {
    if (!Number.isInteger(s.seat) || s.seat < 1 || s.seat > tableSize) {
      throw new Error(`There is no seat ${s.seat} at a ${tableSize}-seat table.`);
    }
    if (s.stack !== null && !(s.stack > 0 && s.stack <= LIVE_LIMITS.maxAmount)) throw new Error(`Seat ${s.seat}: the stack is not a valid amount.`);
  }
  const button = Number(raw.button_seat);
  if (!Number.isInteger(button) || button < 1 || button > tableSize) throw new Error("Put the button on a seat.");
  const hero = raw.hero_seat == null ? null : Number(raw.hero_seat);
  if (hero !== null && !seats.some((s) => s.seat === hero)) throw new Error("Your seat is not dealt in.");

  const used = new Set<string>();
  const take = (card: string, where: string) => {
    if (!CARD_RE.test(card)) throw new Error(`${where}: "${card}" is not a card.`);
    if (used.has(card)) throw new Error(`${card} appears twice.`);
    used.add(card);
  };

  let heroCards: string | null = null;
  if (raw.hero_cards) {
    const pair = splitCards(raw.hero_cards);
    if (!pair) throw new Error("Your cards must be two different cards.");
    pair.forEach((c) => take(c, "Your cards"));
    heroCards = pair.join("");
  }
  const board = (raw.board ?? []).filter(Boolean);
  if (board.length > 5) throw new Error("A board has five cards at most.");
  board.forEach((c) => take(c, "Board"));

  const shown: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.shown ?? {})) {
    if (!v) continue;
    const seat = Number(k);
    if (!seats.some((s) => s.seat === seat)) throw new Error(`Seat ${k} was not in the hand.`);
    if (seat === hero) continue; // his own cards are hero_cards
    const pair = splitCards(v);
    if (!pair) throw new Error(`Seat ${k}: shown cards must be two different cards.`);
    pair.forEach((c) => take(c, `Seat ${k}`));
    shown[String(seat)] = pair.join("");
  }

  const sb = r2(Number(raw.small_blind));
  const bb = r2(Number(raw.big_blind));
  const straddle = raw.straddle == null ? null : r2(Number(raw.straddle));
  const actions = (raw.actions ?? []).map((a) => {
    const out: HandInput["actions"][number] = { seat: Number(a.seat), kind: a.kind };
    if (a.kind === "bet" || a.kind === "raise") out.to = r2(Number(a.to));
    if (a.all_in) out.all_in = true;
    return out;
  });

  let play: PlayResult;
  try {
    play = playHand({ seats, button, sb, bb, straddle }, actions);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
  if (!play.ok) throw new Error(`Action ${play.failedAt! + 1}: ${play.error}`);
  // A board longer than the streets reached is a typo, unless all-in ran it out.
  const reached = play.state.end?.reason === "showdown" ? 5 : BOARD_SIZE[play.state.street];
  if (board.length > reached) throw new Error(`The board has ${board.length} cards, but the hand stopped before that.`);

  const winners = (raw.winners ?? []).map((w) =>
    [...new Set((w ?? []).map(Number))].filter((s) => seats.some((x) => x.seat === s)),
  );
  const settlement = settle(play.state, winners);

  const heroNet = raw.hero_net == null ? null : r2(Number(raw.hero_net));
  if (heroNet !== null && (!Number.isFinite(heroNet) || Math.abs(heroNet) > LIVE_LIMITS.maxAmount)) {
    throw new Error("Your result on the hand is not a valid amount.");
  }

  const notes = raw.notes?.trim() ? raw.notes.trim() : null;
  if (notes && notes.length > LIVE_LIMITS.maxHandNotes) throw new Error(`Notes: at most ${LIVE_LIMITS.maxHandNotes} characters.`);

  return {
    input: {
      played_at: raw.played_at,
      button_seat: button,
      hero_seat: hero,
      small_blind: sb,
      big_blind: bb,
      straddle,
      seats,
      actions,
      hero_cards: heroCards,
      board,
      shown,
      winners: settlement.pots.map((p) => p.takers),
      hero_net: heroNet,
      starred: Boolean(raw.starred),
      notes,
    },
    play,
    settlement,
  };
}

/** Arthur's net from the pots, when every pot he could win has a taker. */
export function computedHeroNet(c: Pick<CheckedHand, "settlement">, hero: number | null): number | null {
  if (hero === null) return null;
  const open = c.settlement.pots.some((p) => p.takers.length === 0 && p.eligible.includes(hero));
  if (open) return null;
  return c.settlement.net.get(hero) ?? null;
}
