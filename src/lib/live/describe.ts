/**
 * Hands in words, for the Claude connector: one block per hand that reads
 * like a hand history, with names, positions and the result.
 */

import { describeStep, playHand, positions, settle } from "./hand";
import { BOARD_SIZE, STREET_LABELS, fmtChips, type LiveHand, type Street } from "./types";

export function handText(hand: LiveHand, nameOf: (playerId: string | null) => string | null, currency: string): string {
  const pos = positions(
    hand.seats.map((s) => s.seat),
    hand.button_seat,
  );
  const who = (seat: number) => {
    const s = hand.seats.find((x) => x.seat === seat);
    const name = seat === hand.hero_seat ? "Arthur" : (nameOf(s?.player_id ?? null) ?? `seat ${seat}`);
    return `${name} (${pos.get(seat) ?? `seat ${seat}`})`;
  };

  const head = [
    `### Hand #${hand.number}${hand.starred ? " ★" : ""} (hand ${hand.id})`,
    `Blinds ${fmtChips(hand.small_blind)}/${fmtChips(hand.big_blind)}${hand.straddle ? `, straddle ${fmtChips(hand.straddle)}` : ""} · button seat ${hand.button_seat} · ${hand.seats.length} dealt in`,
    `Seats: ${hand.seats
      .map((s) => `${s.seat} ${who(s.seat)}${s.stack != null ? ` ${fmtChips(s.stack)}` : ""}`)
      .join(", ")}`,
  ];
  if (hand.hero_cards) head.push(`Arthur holds ${hand.hero_cards}`);

  let play;
  try {
    play = playHand(
      { seats: hand.seats, button: hand.button_seat, sb: hand.small_blind, bb: hand.big_blind, straddle: hand.straddle },
      hand.actions,
    );
  } catch (e) {
    return [...head, `(cannot be replayed: ${e instanceof Error ? e.message : String(e)})`].join("\n");
  }

  const lines: string[] = [];
  let street: Street | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (!street) return;
    const n = BOARD_SIZE[street];
    const board = street !== "preflop" && hand.board.length >= n ? ` [${hand.board.slice(0, n).join(" ")}]` : "";
    lines.push(`${STREET_LABELS[street]}${board}: ${buf.join(", ")}`);
    buf = [];
  };
  for (const s of play.steps) {
    if (s.street !== street) {
      flush();
      street = s.street;
    }
    buf.push(`${who(s.action.seat)} ${describeStep(s)}`);
  }
  flush();
  if (play.state.end?.reason === "showdown" && hand.board.length) {
    const reached = street ? BOARD_SIZE[street] : 0;
    if (hand.board.length > reached) lines.push(`Board runs out: ${hand.board.join(" ")}`);
  }
  if (!play.ok) lines.push(`(the action stops at action ${play.failedAt! + 1}: ${play.error})`);

  const shown = Object.entries(hand.shown).map(([seat, cards]) => `${who(Number(seat))} shows ${cards}`);
  if (shown.length) lines.push(shown.join("; "));
  const out = settle(play.state, hand.winners);
  lines.push(
    out.pots
      .map((p, i) => `${i === 0 ? "Pot" : `Side pot ${i}`} ${fmtChips(p.amount)} → ${p.takers.length ? p.takers.map(who).join(" and ") : "not recorded"}`)
      .join("; "),
  );
  if (hand.hero_net != null) lines.push(`Arthur's net: ${hand.hero_net > 0 ? "+" : ""}${fmtChips(hand.hero_net)} ${currency} (before rake)`);
  if (hand.notes) lines.push(`Notes: ${hand.notes}`);
  return [...head, ...lines].join("\n");
}
