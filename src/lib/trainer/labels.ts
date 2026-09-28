/**
 * Short names for tree nodes in trainer screens ("Flop Ks7d2c", "Bet 33%",
 * "c-bet decision"). Pure functions only.
 */

import type { LogEntry } from "../solver/gameState";
import { asAction, asFlop, asStrategy, asStreet, NODE_LABELS, type PokerNode, type Street } from "../solver/types";
import type { LineAction } from "./types";

export function entryLabel(node: PokerNode): string {
  switch (node.type) {
    case "flop":
      return `Flop ${asFlop(node).cards.join("")}`;
    case "turn":
    case "river":
      return `${NODE_LABELS[node.type]} ${asStreet(node).card ?? "?"}`;
    case "strategy":
      return asStrategy(node).label || "Decision";
    case "action":
      return asAction(node).label;
    default:
      return NODE_LABELS[node.type as keyof typeof NODE_LABELS] ?? "Node";
  }
}


export type StreetLine = { street: Street; cards: string[]; actions: { seat: string; label: string; amountBb: number | null; kind: string }[] };

/** The hand street by street: the cards dealt on it and the actions taken, for logs and recaps. */
export function streetLines(log: (LogEntry | LineAction)[], board: string[]): StreetLine[] {
  const cardsOf = (street: Street) =>
    street === "flop" ? board.slice(0, 3) : street === "turn" ? board.slice(3, 4) : street === "river" ? board.slice(4, 5) : [];
  const out: StreetLine[] = [];
  const order: Street[] = ["preflop", "flop", "turn", "river"];
  for (const e of log) {
    const street = (e.street ?? "preflop") as Street;
    let row = out.find((r) => r.street === street);
    if (!row) {
      row = { street, cards: cardsOf(street), actions: [] };
      out.push(row);
    }
    row.actions.push({ seat: e.seat, label: e.label, amountBb: e.amountBb ?? null, kind: e.kind });
  }
  // Streets dealt with no action yet (the board so far).
  for (const street of order.slice(1)) {
    if (cardsOf(street).length > 0 && !out.some((r) => r.street === street)) out.push({ street, cards: cardsOf(street), actions: [] });
  }
  return out.sort((a, b) => order.indexOf(a.street) - order.indexOf(b.street));
}

/** A log as stored with an answer or a hand. */
export function toLine(log: LogEntry[]): LineAction[] {
  return log.map((e) => ({ street: e.street, seat: e.seat, kind: e.kind, label: e.label, amountBb: e.amountBb }));
}
