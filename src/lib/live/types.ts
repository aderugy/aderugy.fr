/**
 * /poker/live — live cash sessions. Shapes and limits shared by the pages,
 * the server actions and the Claude connector. Nothing here touches the
 * database; the rules of play live in ./hand.ts, the table in ./table.ts,
 * money and time in ./session.ts.
 */

export const LIVE_LIMITS = {
  maxVenue: 120,
  maxGame: 40,
  maxName: 80,
  maxDescription: 1000,
  maxTag: 40,
  maxNote: 4000,
  maxSessionNotes: 20000,
  maxHandNotes: 10000,
  maxAmount: 1_000_000,
} as const;

export const TABLE_SIZES = [9, 10] as const;
export type TableSize = (typeof TABLE_SIZES)[number];

export type LiveSession = {
  id: string;
  venue: string;
  game: string;
  small_blind: number;
  big_blind: number;
  currency: string;
  seats: TableSize;
  hero_seat: number;
  /** Where the button is for the next hand; null before the first one. */
  button_seat: number | null;
  started_at: string;
  ended_at: string | null;
  cash_out: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export const SESSION_EVENT_KINDS = ["buy_in", "rebuy", "break_start", "break_end"] as const;
export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number];

export type SessionEvent = {
  id: string;
  session_id: string;
  kind: SessionEventKind;
  amount: number | null;
  at: string;
};

export const SEAT_EVENT_KINDS = ["sit", "sit_out", "back", "leave", "hero_move"] as const;
export type SeatEventKind = (typeof SEAT_EVENT_KINDS)[number];

export type SeatEvent = {
  id: string;
  session_id: string;
  seat: number;
  kind: SeatEventKind;
  player_id: string | null;
  at: string;
  created_at: string;
};

export type LiveTag = {
  id: string;
  name: string;
  color: string | null;
  position: number;
};

export type LivePlayer = {
  id: string;
  name: string;
  description: string | null;
  /**
   * False for someone not identified yet: seated as "Unknown 4", tagged and
   * noted like anyone, kept out of the known players' lists until named or
   * merged into the player they turn out to be.
   */
  known: boolean;
  created_at: string;
  updated_at: string;
};

/** A player with what the lists and the table need about them. */
export type PlayerSummary = LivePlayer & {
  tag_ids: string[];
  note_count: number;
  /** When and where they were last seated, if ever. */
  last_seen_at: string | null;
  last_seen_venue: string | null;
};

export type PlayerNote = {
  id: string;
  player_id: string;
  session_id: string | null;
  hand_id: string | null;
  body: string;
  source: "app" | "claude";
  created_at: string;
  updated_at: string;
};

/* ------------------------------------------------------------------ hands */

export const STREETS = ["preflop", "flop", "turn", "river"] as const;
export type Street = (typeof STREETS)[number];

export const STREET_LABELS: Record<Street, string> = {
  preflop: "Preflop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
};

/** Board cards there are once a street is reached. */
export const BOARD_SIZE: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };

export const ACTION_KINDS = ["fold", "check", "call", "bet", "raise"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * One action as stored. `to` is the seat's total commitment on the street
 * after a bet or raise ("raise to 15"); a call's amount is implied. `all_in`
 * marks the seat as having no chips left when its stack is not known.
 */
export type HandAction = {
  seat: number;
  kind: ActionKind;
  to?: number;
  all_in?: boolean;
};

/**
 * Blinds bought back: a player who missed them posts before the cards. `live`
 * counts as their bet on the street (usually a big blind — they keep the
 * option); `dead` goes straight to the pot (usually the small blind).
 */
export type HandPost = {
  seat: number;
  live: number;
  dead: number;
};

/** A seat dealt into the hand. The stack is optional: live, it is an estimate. */
export type HandSeat = {
  seat: number;
  player_id: string | null;
  stack: number | null;
};

export type LiveHand = {
  id: string;
  session_id: string;
  number: number;
  played_at: string;
  button_seat: number;
  hero_seat: number | null;
  small_blind: number;
  big_blind: number;
  straddle: number | null;
  posts: HandPost[];
  seats: HandSeat[];
  actions: HandAction[];
  hero_cards: string | null;
  board: string[];
  shown: Record<string, string>;
  /** Who took each pot, main pot first. */
  winners: number[][];
  hero_net: number | null;
  starred: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

/** What the hand editor sends to be saved. */
export type HandInput = {
  played_at?: string;
  button_seat: number;
  hero_seat: number | null;
  small_blind: number;
  big_blind: number;
  straddle: number | null;
  /** Optional: older callers send none. */
  posts?: HandPost[];
  seats: HandSeat[];
  actions: HandAction[];
  hero_cards: string | null;
  board: string[];
  shown: Record<string, string>;
  winners: number[][];
  hero_net: number | null;
  starred: boolean;
  notes: string | null;
};

/* ---------------------------------------------------------------- helpers */

/** The name an unknown player gets when seated: "Unknown 4". */
export function unknownName(seat: number): string {
  return `Unknown ${seat}`;
}

const DEFAULT_UNKNOWN = /^Unknown \d+$/;

/**
 * What the table shows for an unknown: a nickname if given, else the start of
 * how to recognise them ("red cap"), else "?" — the seat number is already on
 * the chip.
 */
export function unknownLabel(p: Pick<LivePlayer, "name" | "description">): string {
  if (!DEFAULT_UNKNOWN.test(p.name)) return p.name;
  return p.description?.split(/[,.;\n]/)[0].trim() || "?";
}

/** Whether a player has anything on them beyond the default name. */
export function isBlankUnknown(p: Pick<PlayerSummary, "known" | "name" | "description" | "tag_ids" | "note_count">): boolean {
  return !p.known && !p.description && p.tag_ids.length === 0 && p.note_count === 0 && DEFAULT_UNKNOWN.test(p.name);
}

export const CARD_RE = /^[2-9TJQKA][shdc]$/;

/** "AhKd" → ["Ah", "Kd"]; null for anything that is not two distinct cards. */
export function splitCards(s: string | null | undefined): [string, string] | null {
  if (!s || !/^([2-9TJQKA][shdc]){2}$/.test(s)) return null;
  const a = s.slice(0, 2);
  const b = s.slice(2, 4);
  return a === b ? null : [a, b];
}

/** Money with the session's currency: 1.5 → "1.50 €", 200 → "200 €". */
export function fmtMoney(x: number, currency = "€", signed = false): string {
  const abs = Math.abs(x);
  const body = Number.isInteger(abs) ? String(abs) : abs.toFixed(2);
  const sign = x < 0 ? "−" : signed && x > 0 ? "+" : "";
  return `${sign}${body} ${currency}`;
}

/** A chip amount without currency, as on the table: 2.5, 15, 1200. */
export function fmtChips(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0$/, "");
}

/** Amount in big blinds, one decimal at most. */
export function fmtBb(x: number, bb: number): string {
  if (!bb) return "—";
  const v = x / bb;
  return `${Number.isInteger(v) ? v : v.toFixed(1)} bb`;
}

/** "1/2", "2/5", "0.5/1" */
export function fmtStakes(s: Pick<LiveSession, "small_blind" | "big_blind">): string {
  return `${fmtChips(Number(s.small_blind))}/${fmtChips(Number(s.big_blind))}`;
}

export function parseAmount(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(",", ".").replace(/\s|€/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
