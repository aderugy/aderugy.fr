/**
 * The table of a live session, rebuilt from its seat log. Pure functions.
 *
 * The log is the truth: a seat is empty until someone sits, occupied until
 * they leave, and `sit_out`/`back` say whether its occupant is dealt in.
 * Replaying the log up to a time gives the table as it was then, which is how
 * a hand's default players and the session's history are both derived.
 */

import type { SeatEvent, SeatEventKind } from "./types";

export type Occupant = {
  seat: number;
  player_id: string | null;
  sittingOut: boolean;
  /** When they sat down. */
  since: string;
  /** When their sitting-out state last changed (or when they sat). */
  statusSince: string;
};

export type Table = Map<number, Occupant>;

/** Log order: time, then insertion for events at the same instant. */
export function sortSeatEvents(events: SeatEvent[]): SeatEvent[] {
  return [...events].sort((a, b) => a.at.localeCompare(b.at) || a.created_at.localeCompare(b.created_at));
}

/** Who sits where after every event up to `at` (included); the whole log by default. */
export function tableAt(events: SeatEvent[], at?: string): Table {
  const table: Table = new Map();
  const limit = at ? Date.parse(at) : Infinity;
  for (const e of sortSeatEvents(events)) {
    if (Date.parse(e.at) > limit) break;
    const cur = table.get(e.seat);
    switch (e.kind) {
      case "sit":
        table.set(e.seat, { seat: e.seat, player_id: e.player_id, sittingOut: false, since: e.at, statusSince: e.at });
        break;
      case "sit_out":
        if (cur) table.set(e.seat, { ...cur, sittingOut: true, statusSince: e.at, player_id: cur.player_id ?? e.player_id });
        break;
      case "back":
        if (cur) table.set(e.seat, { ...cur, sittingOut: false, statusSince: e.at, player_id: cur.player_id ?? e.player_id });
        break;
      case "leave":
        table.delete(e.seat);
        break;
      case "hero_move":
        break;
    }
  }
  return table;
}

/** Where Arthur sat at `at`: the last hero_move up to then, else `fallback`. */
export function heroSeatAt(events: SeatEvent[], fallback: number, at?: string): number {
  const limit = at ? Date.parse(at) : Infinity;
  let seat = fallback;
  let seen = false;
  for (const e of sortSeatEvents(events)) {
    if (Date.parse(e.at) > limit) break;
    if (e.kind === "hero_move") {
      seat = e.seat;
      seen = true;
    }
  }
  // Before the first move was logged, he was where the first one says he went.
  if (!seen) {
    const first = sortSeatEvents(events).find((e) => e.kind === "hero_move");
    if (first) return first.seat;
  }
  return seat;
}

/** The seats dealt into the next hand: everyone sitting in, and Arthur. */
export function dealtIn(table: Table, heroSeat: number): number[] {
  const seats = new Set<number>([heroSeat]);
  for (const o of table.values()) if (!o.sittingOut) seats.add(o.seat);
  return [...seats].sort((a, b) => a - b);
}

/**
 * The next button: the first dealt-in seat clockwise after the last one.
 * With no previous button, the lowest dealt-in seat.
 */
export function nextButton(prev: number | null, dealt: number[]): number {
  const sorted = [...dealt].sort((a, b) => a - b);
  if (!sorted.length) return prev ?? 1;
  if (prev === null) return sorted[0];
  return sorted.find((s) => s > prev) ?? sorted[0];
}

/** Seats with nobody, in order, never Arthur's. */
export function emptySeats(table: Table, size: number, heroSeat: number): number[] {
  const out: number[] = [];
  for (let s = 1; s <= size; s++) if (s !== heroSeat && !table.has(s)) out.push(s);
  return out;
}

/** Where `player` sits, if they are at the table. */
export function seatOfPlayer(table: Table, playerId: string): number | null {
  for (const o of table.values()) if (o.player_id === playerId) return o.seat;
  return null;
}

/**
 * Whether a seat event may be logged now, as a sentence when it may not.
 * Mirrors what the table screen offers, so a stale page cannot log nonsense.
 */
export function checkSeatEvent(
  table: Table,
  heroSeat: number,
  size: number,
  kind: SeatEventKind,
  seat: number,
): string | null {
  if (!Number.isInteger(seat) || seat < 1 || seat > size) return `There is no seat ${seat} at a ${size}-seat table.`;
  const cur = table.get(seat);
  switch (kind) {
    case "sit":
      if (seat === heroSeat) return `Seat ${seat} is yours.`;
      if (cur) return `Seat ${seat} is taken.`;
      return null;
    case "sit_out":
      if (!cur) return `Nobody sits in seat ${seat}.`;
      if (cur.sittingOut) return `Seat ${seat} is already sitting out.`;
      return null;
    case "back":
      if (!cur) return `Nobody sits in seat ${seat}.`;
      if (!cur.sittingOut) return `Seat ${seat} is already playing.`;
      return null;
    case "leave":
      if (!cur) return `Nobody sits in seat ${seat}.`;
      return null;
    case "hero_move":
      if (seat === heroSeat) return `You are already in seat ${seat}.`;
      if (cur) return `Seat ${seat} is taken.`;
      return null;
  }
}

const VERBS: Record<SeatEventKind, string> = {
  sit: "sits in seat",
  sit_out: "sits out in seat",
  back: "is back in seat",
  leave: "leaves seat",
  hero_move: "You move to seat",
};

/** "Marco sits in seat 4", "You move to seat 2" */
export function describeSeatEvent(e: Pick<SeatEvent, "kind" | "seat">, name: string | null): string {
  if (e.kind === "hero_move") return `${VERBS.hero_move} ${e.seat}`;
  return `${name ?? "Someone"} ${VERBS[e.kind]} ${e.seat}`;
}

/**
 * The log for reading: a change of seat (a leave and a sit of the same
 * player at the same instant) becomes one entry with `movedTo`.
 */
export function readableSeatLog(events: SeatEvent[]): { event: SeatEvent; movedTo: SeatEvent | null }[] {
  const sorted = sortSeatEvents(events);
  const moves = new Map<string, SeatEvent>();
  for (const e of sorted) {
    if (e.kind !== "sit" || !e.player_id) continue;
    const left = sorted.find((x) => x.kind === "leave" && x.at === e.at && x.player_id === e.player_id && x.seat !== e.seat);
    if (left) moves.set(left.id, e);
  }
  const merged = new Set([...moves.values()].map((e) => e.id));
  return sorted.filter((e) => !merged.has(e.id)).map((event) => ({ event, movedTo: moves.get(event.id) ?? null }));
}

/** "Lena moves from seat 9 to 1" */
export function describeMove(from: Pick<SeatEvent, "seat">, to: Pick<SeatEvent, "seat">, name: string | null): string {
  return `${name ?? "Someone"} moves from seat ${from.seat} to ${to.seat}`;
}
