import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Result } from "@/server/agenda/tasks";
import {
  LIVE_LIMITS,
  TABLE_SIZES,
  type HandInput,
  type HandPost,
  type LiveHand,
  type LivePlayer,
  type LiveSession,
  type LiveTag,
  type PlayerNote,
  type PlayerSummary,
  type SeatEvent,
  type SeatEventKind,
  type SessionEvent,
  unknownName,
} from "@/lib/live/types";
import { buttonFor, checkSeatEvent, dealtIn, heroSeatAt, nextButton, seatedTogether, sortSeatEvents, tableAt } from "@/lib/live/table";
import { breaksOf } from "@/lib/live/session";
import { addToStack, moveStack, stacksAfterHand, withStack, type Stacks } from "@/lib/live/stacks";
import { checkHand } from "@/lib/live/validate";

/**
 * /poker/live persistence shared by the pages' server actions and the Claude
 * connector. Every function takes the client to act through (cookie-bound
 * for the UI, bearer-token for Claude); both run as the user under RLS, and
 * the OAuth-client rules of migration 0018 apply to the connector without
 * anything here having to know.
 *
 * Throws on database errors; returns `{ ok: false }` for anything the caller
 * should show as a sentence.
 */

const SESSION_COLUMNS =
  "id, venue, game, small_blind, big_blind, currency, seats, hero_seat, button_seat, stacks, started_at, ended_at, cash_out, notes, created_at, updated_at";
const EVENT_COLUMNS = "id, session_id, kind, amount, at";
const SEAT_EVENT_COLUMNS = "id, session_id, seat, kind, player_id, at, created_at";
const PLAYER_COLUMNS = "id, name, description, known, created_at, updated_at";
const TAG_COLUMNS = "id, name, color, position";
const NOTE_COLUMNS = "id, player_id, session_id, hand_id, body, source, created_at, updated_at";
const HAND_COLUMNS =
  "id, session_id, number, played_at, button_seat, hero_seat, small_blind, big_blind, straddle, posts, seats, actions, hero_cards, board, shown, winners, hero_net, starred, notes, created_at, updated_at";

const COLOR = /^#[0-9a-fA-F]{6}$/;

/* ---------------------------------------------------------------- shared */

function pgCode(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

function cleanText(s: string | null | undefined): string | null {
  const t = s?.trim().replace(/\s+/g, " ");
  return t ? t : null;
}

function cleanLong(s: string | null | undefined): string | null {
  const t = s?.replace(/\r\n/g, "\n").trim();
  return t ? t : null;
}

function tooLong(value: string | null, max: number, what: string): string | null {
  return value && value.length > max ? `${what}: at most ${max} characters.` : null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function amount(raw: unknown, what: string, allowZero = false): number | string {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(",", "."));
  if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0) || n > LIVE_LIMITS.maxAmount) {
    return `${what} must be ${allowZero ? "zero or more" : "a positive amount"}.`;
  }
  return r2(n);
}

function isoOrNow(raw: string | null | undefined): string | null {
  if (!raw) return new Date().toISOString();
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function num(v: unknown): number {
  return Number(v);
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** numeric comes back as a number or a string depending on the driver; make it a number. */
function asSession(row: Record<string, unknown>): LiveSession {
  return {
    ...(row as unknown as LiveSession),
    small_blind: num(row.small_blind),
    big_blind: num(row.big_blind),
    cash_out: numOrNull(row.cash_out),
    stacks: Object.fromEntries(
      Object.entries((row.stacks as Record<string, unknown> | null) ?? {})
        .map(([k, v]) => [k, Number(v)] as const)
        .filter(([, v]) => Number.isFinite(v) && v > 0),
    ),
  };
}

async function saveStacks(db: SupabaseClient, userId: string, sessionId: string, stacks: Stacks): Promise<void> {
  const { error } = await db.from("live_sessions").update({ stacks }).eq("user_id", userId).eq("id", sessionId);
  if (error) throw error;
}

function asEvent(row: Record<string, unknown>): SessionEvent {
  return { ...(row as unknown as SessionEvent), amount: numOrNull(row.amount) };
}

function asHand(row: Record<string, unknown>): LiveHand {
  const h = row as unknown as LiveHand;
  return {
    ...h,
    small_blind: num(row.small_blind),
    big_blind: num(row.big_blind),
    straddle: numOrNull(row.straddle),
    hero_net: numOrNull(row.hero_net),
    seats: (h.seats ?? []).map((s) => ({ seat: num(s.seat), player_id: s.player_id ?? null, stack: numOrNull(s.stack) })),
    posts: ((h.posts ?? []) as HandPost[]).map((p) => ({ seat: num(p.seat), live: num(p.live ?? 0), dead: num(p.dead ?? 0) })),
    board: h.board ?? [],
    shown: h.shown ?? {},
    winners: Array.isArray(h.winners) ? h.winners : [],
    actions: h.actions ?? [],
  };
}

/* -------------------------------------------------------------- sessions */

export type SessionRow = LiveSession & { events: SessionEvent[]; hand_count: number };

export async function listSessions(db: SupabaseClient, userId: string, limit = 200): Promise<SessionRow[]> {
  const { data, error } = await db
    .from("live_sessions")
    .select(`${SESSION_COLUMNS}, live_session_events(${EVENT_COLUMNS}), live_hands(count)`)
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => {
    const { live_session_events, live_hands, ...rest } = row as Record<string, unknown> & {
      live_session_events: Record<string, unknown>[];
      live_hands: { count: number }[];
    };
    return {
      ...asSession(rest),
      events: (live_session_events ?? []).map(asEvent),
      hand_count: live_hands?.[0]?.count ?? 0,
    };
  });
}

export async function getRunningSessionId(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await db
    .from("live_sessions")
    .select("id")
    .eq("user_id", userId)
    .is("ended_at", null)
    .maybeSingle();
  if (error) throw error;
  return (data?.id as string | undefined) ?? null;
}

export async function getSession(db: SupabaseClient, userId: string, id: string): Promise<LiveSession | null> {
  const { data, error } = await db
    .from("live_sessions")
    .select(SESSION_COLUMNS)
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? asSession(data) : null;
}

/** Venues played before, most recent first, for the start form. */
export async function recentVenues(db: SupabaseClient, userId: string): Promise<string[]> {
  const { data, error } = await db
    .from("live_sessions")
    .select("venue, started_at")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of data ?? []) {
    const k = String(r.venue).toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(String(r.venue));
    }
  }
  return out;
}

export type NewSession = {
  venue: string;
  game?: string;
  small_blind: number | string;
  big_blind: number | string;
  currency?: string;
  seats: number;
  hero_seat: number;
  buy_in: number | string;
  started_at?: string | null;
  /** Seat a fresh unknown player in every other seat (the default). */
  fill_unknowns?: boolean;
};

type SessionFields = {
  venue?: string;
  game?: string;
  small_blind?: number | string;
  big_blind?: number | string;
  currency?: string;
};

function checkSessionFields(input: SessionFields, current?: LiveSession): Record<string, unknown> | string {
  const patch: Record<string, unknown> = {};
  if (input.venue !== undefined) {
    const venue = cleanText(input.venue);
    if (!venue) return "Say where you play.";
    const p = tooLong(venue, LIVE_LIMITS.maxVenue, "The venue");
    if (p) return p;
    patch.venue = venue;
  }
  if (input.game !== undefined) {
    const game = cleanText(input.game) ?? "NLHE";
    const p = tooLong(game, LIVE_LIMITS.maxGame, "The game");
    if (p) return p;
    patch.game = game;
  }
  if (input.small_blind !== undefined) {
    const sb = amount(input.small_blind, "The small blind");
    if (typeof sb === "string") return sb;
    patch.small_blind = sb;
  }
  if (input.big_blind !== undefined) {
    const bb = amount(input.big_blind, "The big blind");
    if (typeof bb === "string") return bb;
    patch.big_blind = bb;
  }
  const sb = (patch.small_blind as number | undefined) ?? current?.small_blind;
  const bb = (patch.big_blind as number | undefined) ?? current?.big_blind;
  if (sb !== undefined && bb !== undefined && bb < sb) return "The big blind must be at least the small blind.";
  if (input.currency !== undefined) {
    const c = cleanText(input.currency) ?? "€";
    if (c.length > 4) return "A currency is at most 4 characters (€, $, CHF…).";
    patch.currency = c;
  }
  return patch;
}

export async function startSession(db: SupabaseClient, userId: string, input: NewSession): Promise<Result<LiveSession>> {
  const fields = checkSessionFields({
    venue: input.venue,
    game: input.game ?? "NLHE",
    small_blind: input.small_blind,
    big_blind: input.big_blind,
    currency: input.currency ?? "€",
  });
  if (typeof fields === "string") return { ok: false, error: fields };
  const seats = Number(input.seats);
  if (!(TABLE_SIZES as readonly number[]).includes(seats)) return { ok: false, error: "A full-ring table has 9 or 10 seats." };
  const hero = Number(input.hero_seat);
  if (!Number.isInteger(hero) || hero < 1 || hero > seats) return { ok: false, error: `Pick your seat, 1 to ${seats}.` };
  const buyIn = amount(input.buy_in, "The buy-in");
  if (typeof buyIn === "string") return { ok: false, error: buyIn };
  const startedAt = isoOrNow(input.started_at);
  if (!startedAt) return { ok: false, error: "The start time is not a valid time." };
  if (Date.parse(startedAt) > Date.now() + 5 * 60_000) return { ok: false, error: "A session cannot start in the future." };

  const { data, error } = await db
    .from("live_sessions")
    .insert({ user_id: userId, ...fields, seats, hero_seat: hero, started_at: startedAt, stacks: { [String(hero)]: buyIn } })
    .select(SESSION_COLUMNS)
    .single();
  if (error) {
    if (pgCode(error) === "23505") return { ok: false, error: "A session is already running. End it first." };
    throw error;
  }
  const session = asSession(data);

  // The first buy-in and Arthur's seat are the first lines of the log.
  const [money, seat] = await Promise.all([
    db.from("live_session_events").insert({ user_id: userId, session_id: session.id, kind: "buy_in", amount: buyIn, at: startedAt }),
    db.from("live_seat_events").insert({ user_id: userId, session_id: session.id, seat: hero, kind: "hero_move", at: startedAt }),
  ]);
  if (money.error || seat.error) {
    await db.from("live_sessions").delete().eq("user_id", userId).eq("id", session.id);
    throw money.error ?? seat.error;
  }

  // A full table of strangers: one unknown player per seat, sat a moment
  // after Arthur so the log reads in that order.
  if (input.fill_unknowns !== false) {
    const others = Array.from({ length: seats }, (_, i) => i + 1).filter((n) => n !== hero);
    const { data: created, error: e1 } = await db
      .from("live_players")
      .insert(others.map((n) => ({ user_id: userId, name: unknownName(n), known: false })))
      .select("id, name");
    if (e1) throw e1;
    const byName = new Map((created ?? []).map((p) => [p.name as string, p.id as string]));
    const at = new Date(Date.parse(startedAt) + 1).toISOString();
    const { error: e2 } = await db.from("live_seat_events").insert(
      others.map((n) => ({ user_id: userId, session_id: session.id, seat: n, kind: "sit", player_id: byName.get(unknownName(n)) ?? null, at })),
    );
    if (e2) throw e2;
  }
  return { ok: true, value: session };
}

export type SessionPatch = SessionFields & {
  started_at?: string;
  ended_at?: string;
  cash_out?: number | string;
  notes?: string | null;
};

export async function patchSession(
  db: SupabaseClient,
  userId: string,
  id: string,
  input: SessionPatch,
): Promise<Result<LiveSession>> {
  const current = await getSession(db, userId, id);
  if (!current) return { ok: false, error: "No such session." };
  const fields = checkSessionFields(input, current);
  if (typeof fields === "string") return { ok: false, error: fields };
  const patch: Record<string, unknown> = { ...fields };

  if (input.started_at !== undefined) {
    const t = isoOrNow(input.started_at);
    if (!t) return { ok: false, error: "The start time is not a valid time." };
    patch.started_at = t;
  }
  if (input.ended_at !== undefined) {
    if (!current.ended_at) return { ok: false, error: "End the session to set when it ended." };
    const t = isoOrNow(input.ended_at);
    if (!t) return { ok: false, error: "The end time is not a valid time." };
    patch.ended_at = t;
  }
  const start = Date.parse((patch.started_at as string) ?? current.started_at);
  const end = (patch.ended_at as string) ?? current.ended_at;
  if (end && Date.parse(end) < start) return { ok: false, error: "A session cannot end before it starts." };

  if (input.cash_out !== undefined) {
    if (!current.ended_at) return { ok: false, error: "The cash-out is set when the session ends." };
    const c = amount(input.cash_out, "The cash-out", true);
    if (typeof c === "string") return { ok: false, error: c };
    patch.cash_out = c;
  }
  if (input.notes !== undefined) {
    const notes = cleanLong(input.notes);
    const p = tooLong(notes, LIVE_LIMITS.maxSessionNotes, "Notes");
    if (p) return { ok: false, error: p };
    patch.notes = notes;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "Nothing to change." };

  const { data, error } = await db
    .from("live_sessions")
    .update(patch)
    .eq("user_id", userId)
    .eq("id", id)
    .select(SESSION_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, error: "No such session." };
  return { ok: true, value: asSession(data) };
}

/** Cash out: closes an open break, then the session. */
export async function endSession(
  db: SupabaseClient,
  userId: string,
  id: string,
  input: { cash_out: number | string; ended_at?: string | null },
): Promise<Result> {
  const current = await getSession(db, userId, id);
  if (!current) return { ok: false, error: "No such session." };
  if (current.ended_at) return { ok: false, error: "This session has already ended." };
  const cash = amount(input.cash_out, "The cash-out", true);
  if (typeof cash === "string") return { ok: false, error: cash };
  const endedAt = isoOrNow(input.ended_at);
  if (!endedAt) return { ok: false, error: "The end time is not a valid time." };
  if (Date.parse(endedAt) < Date.parse(current.started_at)) return { ok: false, error: "A session cannot end before it starts." };

  const events = await loadSessionEvents(db, userId, id);
  const breaks = breaksOf(events);
  if (breaks.length && breaks[breaks.length - 1].end === null) {
    const { error } = await db
      .from("live_session_events")
      .insert({ user_id: userId, session_id: id, kind: "break_end", at: endedAt });
    if (error) throw error;
  }
  const { error } = await db
    .from("live_sessions")
    .update({ ended_at: endedAt, cash_out: cash })
    .eq("user_id", userId)
    .eq("id", id);
  if (error) throw error;
  return { ok: true };
}

/** Undo an end: the session runs again (if no other one does). */
export async function reopenSession(db: SupabaseClient, userId: string, id: string): Promise<Result> {
  const { error, count } = await db
    .from("live_sessions")
    .update({ ended_at: null, cash_out: null }, { count: "exact" })
    .eq("user_id", userId)
    .eq("id", id);
  if (error) {
    if (pgCode(error) === "23505") return { ok: false, error: "Another session is running. End it first." };
    throw error;
  }
  if (!count) return { ok: false, error: "No such session." };
  return { ok: true };
}

export async function removeSession(db: SupabaseClient, userId: string, id: string): Promise<Result> {
  const { error, count } = await db.from("live_sessions").delete({ count: "exact" }).eq("user_id", userId).eq("id", id);
  if (error) throw error;
  if (!count) return { ok: false, error: "No such session." };
  return { ok: true };
}

/* ------------------------------------------------------ money and breaks */

export async function loadSessionEvents(db: SupabaseClient, userId: string, sessionId: string): Promise<SessionEvent[]> {
  const { data, error } = await db
    .from("live_session_events")
    .select(EVENT_COLUMNS)
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .order("at");
  if (error) throw error;
  return (data ?? []).map(asEvent);
}

export async function addMoney(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  input: { kind: "buy_in" | "rebuy"; amount: number | string; at?: string | null },
): Promise<Result> {
  const value = amount(input.amount, input.kind === "rebuy" ? "A rebuy" : "A buy-in");
  if (typeof value === "string") return { ok: false, error: value };
  const at = isoOrNow(input.at);
  if (!at) return { ok: false, error: "Not a valid time." };
  const { error } = await db
    .from("live_session_events")
    .insert({ user_id: userId, session_id: sessionId, kind: input.kind, amount: value, at });
  if (error) throw error;
  // Money in during the session lands on Arthur's stack.
  const session = await getSession(db, userId, sessionId);
  if (session && !session.ended_at) await saveStacks(db, userId, sessionId, addToStack(session.stacks, session.hero_seat, value));
  return { ok: true };
}

/** Start a break, or end the one running. */
export async function toggleBreak(db: SupabaseClient, userId: string, sessionId: string): Promise<Result<"started" | "ended">> {
  const session = await getSession(db, userId, sessionId);
  if (!session) return { ok: false, error: "No such session." };
  if (session.ended_at) return { ok: false, error: "This session has ended." };
  const breaks = breaksOf(await loadSessionEvents(db, userId, sessionId));
  const open = breaks.length > 0 && breaks[breaks.length - 1].end === null;
  const { error } = await db
    .from("live_session_events")
    .insert({ user_id: userId, session_id: sessionId, kind: open ? "break_end" : "break_start" });
  if (error) throw error;
  return { ok: true, value: open ? "ended" : "started" };
}

export async function removeSessionEvent(db: SupabaseClient, userId: string, eventId: string): Promise<Result> {
  const { data: row, error: readError } = await db
    .from("live_session_events")
    .select("session_id, kind")
    .eq("user_id", userId)
    .eq("id", eventId)
    .maybeSingle();
  if (readError) throw readError;
  if (!row) return { ok: false, error: "Already removed." };
  if (row.kind === "buy_in") {
    const { count } = await db
      .from("live_session_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("session_id", row.session_id)
      .eq("kind", "buy_in");
    if ((count ?? 0) <= 1) return { ok: false, error: "A session keeps its buy-in. Change the amount instead." };
  }
  const { error } = await db.from("live_session_events").delete().eq("user_id", userId).eq("id", eventId);
  if (error) throw error;
  return { ok: true };
}

export async function patchMoney(db: SupabaseClient, userId: string, eventId: string, raw: number | string): Promise<Result> {
  const value = amount(raw, "The amount");
  if (typeof value === "string") return { ok: false, error: value };
  const { error, count } = await db
    .from("live_session_events")
    .update({ amount: value }, { count: "exact" })
    .eq("user_id", userId)
    .eq("id", eventId)
    .in("kind", ["buy_in", "rebuy"]);
  if (error) throw error;
  if (!count) return { ok: false, error: "No such buy-in or rebuy." };
  return { ok: true };
}

/* ------------------------------------------------------------- the table */

export async function loadSeatEvents(db: SupabaseClient, userId: string, sessionId: string): Promise<SeatEvent[]> {
  const { data, error } = await db
    .from("live_seat_events")
    .select(SEAT_EVENT_COLUMNS)
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .order("at")
    .order("created_at");
  if (error) throw error;
  return (data ?? []) as SeatEvent[];
}

async function tableContext(db: SupabaseClient, userId: string, sessionId: string) {
  const [session, events] = await Promise.all([getSession(db, userId, sessionId), loadSeatEvents(db, userId, sessionId)]);
  if (!session) return null;
  return { session, events, table: tableAt(events) };
}

/**
 * Log one change at the table, after checking it against the table as it is
 * now. A player already seated elsewhere cannot sit a second time.
 */
export async function logSeatEvent(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  input: { kind: SeatEventKind; seat: number; player_id?: string | null },
): Promise<Result> {
  const ctx = await tableContext(db, userId, sessionId);
  if (!ctx) return { ok: false, error: "No such session." };
  if (ctx.session.ended_at) return { ok: false, error: "This session has ended." };
  const seat = Number(input.seat);
  const problem = checkSeatEvent(ctx.table, ctx.session.hero_seat, ctx.session.seats, input.kind, seat);
  if (problem) return { ok: false, error: problem };

  let playerId: string | null = null;
  if (input.kind === "sit") {
    playerId = input.player_id ?? null;
    if (playerId) {
      for (const o of ctx.table.values()) {
        if (o.player_id === playerId) return { ok: false, error: `They are already in seat ${o.seat}. Move them instead.` };
      }
    }
  } else if (input.kind !== "hero_move") {
    playerId = ctx.table.get(seat)?.player_id ?? null;
  }

  const { error } = await db
    .from("live_seat_events")
    .insert({ user_id: userId, session_id: sessionId, seat, kind: input.kind, player_id: playerId });
  if (error) {
    if (pgCode(error) === "23514") return { ok: false, error: `There is no seat ${seat} at this table.` };
    throw error;
  }
  if (input.kind === "hero_move") {
    const { error: e2 } = await db
      .from("live_sessions")
      .update({ hero_seat: seat, stacks: moveStack(ctx.session.stacks, ctx.session.hero_seat, seat) })
      .eq("user_id", userId)
      .eq("id", sessionId);
    if (e2) throw e2;
  } else if (input.kind === "leave" || input.kind === "sit") {
    // A seat that empties, or fills with someone new, starts with no known stack.
    await saveStacks(db, userId, sessionId, withStack(ctx.session.stacks, seat, null));
  }
  return { ok: true };
}

/** What a seat has in front of it now; null or "" clears it. */
export async function setStack(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  seat: number,
  raw: number | string | null,
): Promise<Result> {
  const session = await getSession(db, userId, sessionId);
  if (!session) return { ok: false, error: "No such session." };
  if (session.ended_at) return { ok: false, error: "This session has ended." };
  if (!Number.isInteger(seat) || seat < 1 || seat > session.seats) return { ok: false, error: `There is no seat ${seat}.` };
  let value: number | null = null;
  if (raw !== null && String(raw).trim() !== "") {
    const v = amount(raw, "A stack");
    if (typeof v === "string") return { ok: false, error: v };
    value = v;
  }
  await saveStacks(db, userId, sessionId, withStack(session.stacks, seat, value));
  return { ok: true };
}

/** Someone nobody knows sits down: a fresh unknown player, seated. */
export async function seatUnknown(db: SupabaseClient, userId: string, sessionId: string, seat: number): Promise<Result<LivePlayer>> {
  const created = await createPlayer(db, userId, { name: unknownName(Number(seat)), known: false });
  if (!created.ok) return created;
  const r = await logSeatEvent(db, userId, sessionId, { kind: "sit", seat, player_id: created.value.id });
  if (!r.ok) {
    await db.from("live_players").delete().eq("user_id", userId).eq("id", created.value.id);
    return r;
  }
  return created;
}

/**
 * One player leaves and someone new takes the seat straight away: a leave,
 * then a fresh unknown sitting down a millisecond later.
 */
export async function replaceOccupant(db: SupabaseClient, userId: string, sessionId: string, seat: number): Promise<Result> {
  const ctx = await tableContext(db, userId, sessionId);
  if (!ctx) return { ok: false, error: "No such session." };
  if (ctx.session.ended_at) return { ok: false, error: "This session has ended." };
  const occupant = ctx.table.get(seat);
  if (!occupant) return { ok: false, error: `Nobody sits in seat ${seat}.` };
  const created = await createPlayer(db, userId, { name: unknownName(seat), known: false });
  if (!created.ok) return created;
  const at = new Date().toISOString();
  const later = new Date(Date.parse(at) + 1).toISOString();
  const { error } = await db.from("live_seat_events").insert([
    { user_id: userId, session_id: sessionId, seat, kind: "leave", player_id: occupant.player_id, at },
    { user_id: userId, session_id: sessionId, seat, kind: "sit", player_id: created.value.id, at: later },
  ]);
  if (error) {
    await db.from("live_players").delete().eq("user_id", userId).eq("id", created.value.id);
    throw error;
  }
  await saveStacks(db, userId, sessionId, withStack(ctx.session.stacks, seat, null));
  return { ok: true };
}

/**
 * Put the button somewhere for the next hand: on `seat`, or (`"next"`) one
 * seat on, for a hand played without being entered.
 */
export async function moveButton(db: SupabaseClient, userId: string, sessionId: string, to: number | "next"): Promise<Result<number>> {
  const ctx = await tableContext(db, userId, sessionId);
  if (!ctx) return { ok: false, error: "No such session." };
  if (ctx.session.ended_at) return { ok: false, error: "This session has ended." };
  const dealt = dealtIn(ctx.table, ctx.session.hero_seat);
  let seat: number;
  if (to === "next") {
    seat = nextButton(buttonFor(ctx.session.button_seat, dealt), dealt);
  } else {
    seat = Number(to);
    if (!Number.isInteger(seat) || seat < 1 || seat > ctx.session.seats) return { ok: false, error: `There is no seat ${to}.` };
  }
  const { error } = await db.from("live_sessions").update({ button_seat: seat }).eq("user_id", userId).eq("id", sessionId);
  if (error) throw error;
  return { ok: true, value: seat };
}

/** Someone changes seat: they leave one and sit in the other, at the same instant. */
export async function moveSeat(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  from: number,
  to: number,
): Promise<Result> {
  const ctx = await tableContext(db, userId, sessionId);
  if (!ctx) return { ok: false, error: "No such session." };
  if (ctx.session.ended_at) return { ok: false, error: "This session has ended." };
  const occupant = ctx.table.get(from);
  if (!occupant) return { ok: false, error: `Nobody sits in seat ${from}.` };
  const problem = checkSeatEvent(ctx.table, ctx.session.hero_seat, ctx.session.seats, "sit", to);
  if (problem) return { ok: false, error: problem };
  const at = new Date().toISOString();
  const rows = [
    { user_id: userId, session_id: sessionId, seat: from, kind: "leave", player_id: occupant.player_id, at },
    { user_id: userId, session_id: sessionId, seat: to, kind: "sit", player_id: occupant.player_id, at },
  ];
  // Still sitting out in the new seat. A millisecond later, so the log orders
  // it after the sit (rows of one insert share their created_at).
  const later = new Date(Date.parse(at) + 1).toISOString();
  if (occupant.sittingOut) rows.push({ user_id: userId, session_id: sessionId, seat: to, kind: "sit_out", player_id: occupant.player_id, at: later });
  // One insert: all or nothing.
  const { error } = await db.from("live_seat_events").insert(rows);
  if (error) throw error;
  await saveStacks(db, userId, sessionId, moveStack(ctx.session.stacks, from, to));
  return { ok: true };
}

/**
 * Say who sits in a seat: names someone not identified yet, or corrects a
 * wrong pick. Rewrites the player on the occupant's whole current stay.
 */
export async function setOccupant(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  seat: number,
  playerId: string,
): Promise<Result> {
  const ctx = await tableContext(db, userId, sessionId);
  if (!ctx) return { ok: false, error: "No such session." };
  const occupant = ctx.table.get(seat);
  if (!occupant) return { ok: false, error: `Nobody sits in seat ${seat}.` };
  for (const o of ctx.table.values()) {
    if (o.player_id === playerId && o.seat !== seat) return { ok: false, error: `They are already in seat ${o.seat}.` };
  }
  const stay = sortSeatEvents(ctx.events).filter(
    (e) => e.seat === seat && e.kind !== "hero_move" && Date.parse(e.at) >= Date.parse(occupant.since),
  );
  const ids = stay.map((e) => e.id);
  if (!ids.length) return { ok: false, error: `Nobody sits in seat ${seat}.` };
  const { error } = await db.from("live_seat_events").update({ player_id: playerId }).eq("user_id", userId).in("id", ids);
  if (error) {
    if (pgCode(error) === "42501") return { ok: false, error: "No such player." };
    throw error;
  }

  // Hands played during the stay named whoever was thought to sit there:
  // they now name the right person too.
  const { data: hands, error: handsError } = await db
    .from("live_hands")
    .select("id, seats")
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .gte("played_at", occupant.since);
  if (handsError) throw handsError;
  for (const h of (hands ?? []) as { id: string; seats: LiveHand["seats"] }[]) {
    const seats = h.seats.map((s) => (s.seat === seat && s.player_id === occupant.player_id ? { ...s, player_id: playerId } : s));
    if (JSON.stringify(seats) === JSON.stringify(h.seats)) continue;
    const { error: e2 } = await db.from("live_hands").update({ seats }).eq("user_id", userId).eq("id", h.id);
    if (e2) throw e2;
  }
  return { ok: true };
}

/** Undo a line of the table's log. Arthur's first seat stays. */
export async function removeSeatEvent(db: SupabaseClient, userId: string, eventId: string): Promise<Result> {
  const { data: row, error: readError } = await db
    .from("live_seat_events")
    .select(SEAT_EVENT_COLUMNS)
    .eq("user_id", userId)
    .eq("id", eventId)
    .maybeSingle();
  if (readError) throw readError;
  if (!row) return { ok: false, error: "Already removed." };
  const e = row as SeatEvent;
  if (e.kind === "hero_move") {
    const events = await loadSeatEvents(db, userId, e.session_id);
    const moves = events.filter((x) => x.kind === "hero_move");
    if (moves[0]?.id === e.id) return { ok: false, error: "Where you sat first stays. Move seat instead." };
  }
  const { error } = await db.from("live_seat_events").delete().eq("user_id", userId).eq("id", eventId);
  if (error) throw error;
  if (e.kind === "hero_move") {
    const events = await loadSeatEvents(db, userId, e.session_id);
    const seat = heroSeatAt(events, e.seat);
    const { error: e2 } = await db.from("live_sessions").update({ hero_seat: seat }).eq("user_id", userId).eq("id", e.session_id);
    if (e2) throw e2;
  }
  return { ok: true };
}

/* ---------------------------------------------------------------- players */

export async function loadPlayers(db: SupabaseClient, userId: string): Promise<PlayerSummary[]> {
  const [players, links, notes, sits] = await Promise.all([
    db.from("live_players").select(PLAYER_COLUMNS).eq("user_id", userId).order("name"),
    db.from("live_player_tags").select("player_id, tag_id").eq("user_id", userId),
    db.from("live_player_notes").select("player_id").eq("user_id", userId),
    db
      .from("live_seat_events")
      .select("player_id, at, live_sessions(venue)")
      .eq("user_id", userId)
      .eq("kind", "sit")
      .not("player_id", "is", null)
      .order("at", { ascending: false })
      .limit(5000),
  ]);
  for (const r of [players, links, notes, sits]) if (r.error) throw r.error;

  const tagsOf = new Map<string, string[]>();
  for (const l of links.data ?? []) {
    const list = tagsOf.get(l.player_id) ?? [];
    list.push(l.tag_id);
    tagsOf.set(l.player_id, list);
  }
  const noteCount = new Map<string, number>();
  for (const n of notes.data ?? []) noteCount.set(n.player_id, (noteCount.get(n.player_id) ?? 0) + 1);
  const lastSeen = new Map<string, { at: string; venue: string | null }>();
  for (const s of (sits.data ?? []) as unknown as { player_id: string; at: string; live_sessions: { venue: string } | { venue: string }[] | null }[]) {
    if (lastSeen.has(s.player_id)) continue;
    const sess = Array.isArray(s.live_sessions) ? s.live_sessions[0] : s.live_sessions;
    lastSeen.set(s.player_id, { at: s.at, venue: sess?.venue ?? null });
  }
  return ((players.data ?? []) as LivePlayer[]).map((p) => ({
    ...p,
    tag_ids: tagsOf.get(p.id) ?? [],
    note_count: noteCount.get(p.id) ?? 0,
    last_seen_at: lastSeen.get(p.id)?.at ?? null,
    last_seen_venue: lastSeen.get(p.id)?.venue ?? null,
  }));
}

export async function getPlayer(db: SupabaseClient, userId: string, id: string): Promise<LivePlayer | null> {
  const { data, error } = await db.from("live_players").select(PLAYER_COLUMNS).eq("user_id", userId).eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as LivePlayer | null) ?? null;
}

function checkPlayer(input: { name?: string; description?: string | null; known?: boolean }): Record<string, unknown> | string {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = cleanText(input.name);
    if (!name) return "Give them a name, even a nickname.";
    const p = tooLong(name, LIVE_LIMITS.maxName, "A name");
    if (p) return p;
    patch.name = name;
  }
  if (input.description !== undefined) {
    const d = cleanLong(input.description);
    const p = tooLong(d, LIVE_LIMITS.maxDescription, "The description");
    if (p) return p;
    patch.description = d;
  }
  if (input.known !== undefined) patch.known = Boolean(input.known);
  return patch;
}

export async function createPlayer(
  db: SupabaseClient,
  userId: string,
  input: { name: string; description?: string | null; tag_ids?: string[]; known?: boolean },
): Promise<Result<LivePlayer>> {
  const fields = checkPlayer({ name: input.name, description: input.description ?? null, known: input.known ?? true });
  if (typeof fields === "string") return { ok: false, error: fields };
  const { data, error } = await db
    .from("live_players")
    .insert({ user_id: userId, ...fields })
    .select(PLAYER_COLUMNS)
    .single();
  if (error) throw error;
  const player = data as LivePlayer;
  if (input.tag_ids?.length) await setPlayerTags(db, userId, player.id, input.tag_ids);
  return { ok: true, value: player };
}

export async function patchPlayer(
  db: SupabaseClient,
  userId: string,
  id: string,
  input: { name?: string; description?: string | null; known?: boolean },
): Promise<Result> {
  const patch = checkPlayer(input);
  if (typeof patch === "string") return { ok: false, error: patch };
  if (!Object.keys(patch).length) return { ok: false, error: "Nothing to change." };
  const { error, count } = await db.from("live_players").update(patch, { count: "exact" }).eq("user_id", userId).eq("id", id);
  if (error) throw error;
  if (!count) return { ok: false, error: "No such player." };
  return { ok: true };
}

/**
 * "That unknown is Marco": their seats, notes, tags, hands and description
 * move to Marco and the unknown goes (migration 0022). Refused when the two
 * sat at the same table at the same time — they are two people.
 */
export async function mergePlayers(db: SupabaseClient, userId: string, fromId: string, intoId: string): Promise<Result> {
  if (fromId === intoId) return { ok: false, error: "That is the same player." };
  const [from, into] = await Promise.all([getPlayer(db, userId, fromId), getPlayer(db, userId, intoId)]);
  if (!from || !into) return { ok: false, error: "No such player." };

  const { data: sits, error } = await db
    .from("live_seat_events")
    .select("session_id, player_id")
    .eq("user_id", userId)
    .eq("kind", "sit")
    .in("player_id", [fromId, intoId]);
  if (error) throw error;
  const seen = new Map<string, Set<string>>();
  for (const r of sits ?? []) {
    const set = seen.get(r.session_id as string) ?? new Set<string>();
    set.add(r.player_id as string);
    seen.set(r.session_id as string, set);
  }
  for (const [sessionId, who] of seen) {
    if (who.size < 2) continue;
    const events = await loadSeatEvents(db, userId, sessionId);
    if (seatedTogether(events, fromId, intoId)) {
      return { ok: false, error: `${from.name} and ${into.name} sat at the same table at the same time: they are two people.` };
    }
  }

  const { error: e2 } = await db.rpc("live_merge_players", { p_from: fromId, p_into: intoId });
  if (e2) {
    if (pgCode(e2) === "P0002") return { ok: false, error: "No such player." };
    throw e2;
  }
  return { ok: true };
}

/** Delete a player: their notes go, their seats become "someone", their hands stay. */
export async function removePlayer(db: SupabaseClient, userId: string, id: string): Promise<Result> {
  const { error, count } = await db.from("live_players").delete({ count: "exact" }).eq("user_id", userId).eq("id", id);
  if (error) throw error;
  if (!count) return { ok: false, error: "No such player." };
  return { ok: true };
}

/** Make a player's tags exactly this set. */
export async function setPlayerTags(db: SupabaseClient, userId: string, playerId: string, tagIds: string[]): Promise<Result> {
  const wanted = new Set(tagIds);
  const { data, error } = await db.from("live_player_tags").select("tag_id").eq("user_id", userId).eq("player_id", playerId);
  if (error) throw error;
  const have = new Set((data ?? []).map((r) => r.tag_id as string));
  const add = [...wanted].filter((t) => !have.has(t));
  const drop = [...have].filter((t) => !wanted.has(t));
  if (add.length) {
    const { error: e } = await db
      .from("live_player_tags")
      .insert(add.map((tag_id) => ({ user_id: userId, player_id: playerId, tag_id })));
    if (e) {
      if (pgCode(e) === "42501") return { ok: false, error: "No such player or tag." };
      throw e;
    }
  }
  if (drop.length) {
    const { error: e } = await db
      .from("live_player_tags")
      .delete()
      .eq("user_id", userId)
      .eq("player_id", playerId)
      .in("tag_id", drop);
    if (e) throw e;
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ tags */

export async function loadTags(db: SupabaseClient, userId: string): Promise<LiveTag[]> {
  const { data, error } = await db.from("live_tags").select(TAG_COLUMNS).eq("user_id", userId).order("position").order("name");
  if (error) throw error;
  return (data ?? []) as LiveTag[];
}

/** Tags named by id or by name (any case). Unknown names are an error listing the real ones. */
export function resolveTagRefs(tags: LiveTag[], refs: string[]): { ok: true; ids: string[] } | { ok: false; error: string } {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const ref of refs) {
    const r = ref.trim().toLowerCase();
    const tag = tags.find((t) => t.id === ref || t.name.toLowerCase() === r);
    if (tag) ids.push(tag.id);
    else unknown.push(ref);
  }
  if (unknown.length) {
    const known = tags.length ? `Tags: ${tags.map((t) => `"${t.name}"`).join(", ")}.` : "There are no tags yet.";
    return { ok: false, error: `Unknown tag${unknown.length > 1 ? "s" : ""} ${unknown.map((u) => `"${u}"`).join(", ")}. ${known}` };
  }
  return { ok: true, ids: [...new Set(ids)] };
}

export async function insertTag(
  db: SupabaseClient,
  userId: string,
  input: { name: string; color: string | null },
): Promise<Result<LiveTag>> {
  const name = cleanText(input.name);
  if (!name) return { ok: false, error: "Give the tag a name." };
  const p = tooLong(name, LIVE_LIMITS.maxTag, "A tag name");
  if (p) return { ok: false, error: p };
  if (input.color && !COLOR.test(input.color)) return { ok: false, error: "Colour must be #rrggbb." };
  const { data: last } = await db
    .from("live_tags")
    .select("position")
    .eq("user_id", userId)
    .order("position", { ascending: false })
    .limit(1);
  const position = ((last ?? [])[0]?.position ?? -1) + 1;
  const { data, error } = await db
    .from("live_tags")
    .insert({ user_id: userId, name, color: input.color, position })
    .select(TAG_COLUMNS)
    .single();
  if (error) {
    if (pgCode(error) === "23505") return { ok: false, error: `A tag named "${name}" already exists.` };
    throw error;
  }
  return { ok: true, value: data as LiveTag };
}

export async function patchTag(
  db: SupabaseClient,
  userId: string,
  id: string,
  input: { name?: string; color?: string | null; position?: number },
): Promise<Result> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = cleanText(input.name);
    if (!name) return { ok: false, error: "Give the tag a name." };
    const p = tooLong(name, LIVE_LIMITS.maxTag, "A tag name");
    if (p) return { ok: false, error: p };
    patch.name = name;
  }
  if (input.color !== undefined) {
    if (input.color && !COLOR.test(input.color)) return { ok: false, error: "Colour must be #rrggbb." };
    patch.color = input.color;
  }
  if (input.position !== undefined) patch.position = input.position;
  if (!Object.keys(patch).length) return { ok: false, error: "Nothing to change." };
  const { error, count } = await db.from("live_tags").update(patch, { count: "exact" }).eq("user_id", userId).eq("id", id);
  if (error) {
    if (pgCode(error) === "23505") return { ok: false, error: `A tag named "${patch.name}" already exists.` };
    throw error;
  }
  if (!count) return { ok: false, error: "No such tag." };
  return { ok: true };
}

export async function removeTag(db: SupabaseClient, userId: string, id: string): Promise<Result> {
  const { error } = await db.from("live_tags").delete().eq("user_id", userId).eq("id", id);
  if (error) throw error;
  return { ok: true };
}

/* ----------------------------------------------------------------- notes */

export async function loadNotes(
  db: SupabaseClient,
  userId: string,
  filter: { playerIds?: string[]; playerId?: string },
): Promise<PlayerNote[]> {
  let q = db.from("live_player_notes").select(NOTE_COLUMNS).eq("user_id", userId).order("created_at", { ascending: false });
  if (filter.playerId) q = q.eq("player_id", filter.playerId);
  if (filter.playerIds) {
    if (!filter.playerIds.length) return [];
    q = q.in("player_id", filter.playerIds);
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as PlayerNote[];
}

export async function addNote(
  db: SupabaseClient,
  userId: string,
  input: { player_id: string; body: string; session_id?: string | null; hand_id?: string | null },
): Promise<Result<PlayerNote>> {
  const body = cleanLong(input.body);
  if (!body) return { ok: false, error: "Write something." };
  const p = tooLong(body, LIVE_LIMITS.maxNote, "A note");
  if (p) return { ok: false, error: p };
  const { data, error } = await db
    .from("live_player_notes")
    .insert({
      user_id: userId,
      player_id: input.player_id,
      session_id: input.session_id ?? null,
      hand_id: input.hand_id ?? null,
      body,
    })
    .select(NOTE_COLUMNS)
    .single();
  if (error) {
    if (pgCode(error) === "42501") return { ok: false, error: "No such player, session or hand." };
    throw error;
  }
  return { ok: true, value: data as PlayerNote };
}

export async function patchNote(db: SupabaseClient, userId: string, id: string, rawBody: string): Promise<Result> {
  const body = cleanLong(rawBody);
  if (!body) return { ok: false, error: "A note cannot be empty. Delete it instead." };
  const p = tooLong(body, LIVE_LIMITS.maxNote, "A note");
  if (p) return { ok: false, error: p };
  const { error, count } = await db
    .from("live_player_notes")
    .update({ body }, { count: "exact" })
    .eq("user_id", userId)
    .eq("id", id);
  if (error) throw error;
  // Under RLS a connected app editing a note it did not write matches nothing.
  if (!count) return { ok: false, error: "No such note, or not one you may edit." };
  return { ok: true };
}

export async function removeNote(db: SupabaseClient, userId: string, id: string): Promise<Result> {
  const { error, count } = await db.from("live_player_notes").delete({ count: "exact" }).eq("user_id", userId).eq("id", id);
  if (error) throw error;
  if (!count) return { ok: false, error: "No such note, or not one you may delete." };
  return { ok: true };
}

/* ----------------------------------------------------------------- hands */

export async function loadHands(db: SupabaseClient, userId: string, sessionId: string): Promise<LiveHand[]> {
  const { data, error } = await db
    .from("live_hands")
    .select(HAND_COLUMNS)
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .order("number");
  if (error) throw error;
  return (data ?? []).map(asHand);
}

export async function getHand(db: SupabaseClient, userId: string, id: string): Promise<LiveHand | null> {
  const { data, error } = await db.from("live_hands").select(HAND_COLUMNS).eq("user_id", userId).eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? asHand(data) : null;
}

/** Hands a player was dealt into, newest first, with where they were played. */
export async function handsWithPlayer(
  db: SupabaseClient,
  userId: string,
  playerId: string,
  limit = 100,
): Promise<(LiveHand & { venue: string | null; currency: string })[]> {
  const { data, error } = await db
    .from("live_hands")
    .select(`${HAND_COLUMNS}, live_sessions(venue, currency)`)
    .eq("user_id", userId)
    .contains("seats", JSON.stringify([{ player_id: playerId }]))
    .order("played_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => {
    type S = { venue: string; currency: string };
    const { live_sessions, ...rest } = row as Record<string, unknown> & { live_sessions: S | S[] | null };
    const s = Array.isArray(live_sessions) ? live_sessions[0] : live_sessions;
    return { ...asHand(rest), venue: s?.venue ?? null, currency: s?.currency ?? "€" };
  });
}

/** Sessions a player sat in, newest first. */
export async function sessionsWithPlayer(
  db: SupabaseClient,
  userId: string,
  playerId: string,
): Promise<{ id: string; venue: string; started_at: string; seat: number }[]> {
  const { data, error } = await db
    .from("live_seat_events")
    .select("session_id, seat, at, live_sessions(id, venue, started_at)")
    .eq("user_id", userId)
    .eq("player_id", playerId)
    .eq("kind", "sit")
    .order("at", { ascending: false });
  if (error) throw error;
  const out = new Map<string, { id: string; venue: string; started_at: string; seat: number }>();
  for (const row of (data ?? []) as unknown as {
    session_id: string;
    seat: number;
    live_sessions: { id: string; venue: string; started_at: string } | { id: string; venue: string; started_at: string }[] | null;
  }[]) {
    const s = Array.isArray(row.live_sessions) ? row.live_sessions[0] : row.live_sessions;
    if (s && !out.has(s.id)) out.set(s.id, { id: s.id, venue: s.venue, started_at: s.started_at, seat: row.seat });
  }
  return [...out.values()];
}

function handRow(input: HandInput) {
  return {
    button_seat: input.button_seat,
    hero_seat: input.hero_seat,
    small_blind: input.small_blind,
    big_blind: input.big_blind,
    straddle: input.straddle,
    posts: input.posts ?? [],
    seats: input.seats,
    actions: input.actions,
    hero_cards: input.hero_cards,
    board: input.board,
    shown: input.shown,
    winners: input.winners,
    hero_net: input.hero_net,
    starred: input.starred,
    notes: input.notes,
  };
}

export async function createHand(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  raw: HandInput,
): Promise<Result<LiveHand>> {
  const session = await getSession(db, userId, sessionId);
  if (!session) return { ok: false, error: "No such session." };
  let input: HandInput;
  let checked: ReturnType<typeof checkHand>;
  try {
    checked = checkHand(raw, session.seats);
    input = checked.input;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const playedAt = raw.played_at ? isoOrNow(raw.played_at) : new Date().toISOString();
  if (!playedAt) return { ok: false, error: "Not a valid time." };
  const { data, error } = await db
    .from("live_hands")
    .insert({ user_id: userId, session_id: sessionId, played_at: playedAt, ...handRow(input) })
    .select(HAND_COLUMNS)
    .single();
  if (error) throw error;
  // The button moves on, to the next seat that was dealt into this hand, and
  // the stacks move by what each seat won or lost.
  if (!session.ended_at) {
    const next = nextButton(input.button_seat, input.seats.map((s) => s.seat));
    const { error: e2 } = await db
      .from("live_sessions")
      .update({ button_seat: next, stacks: stacksAfterHand(session.stacks, input.seats, checked.settlement) })
      .eq("user_id", userId)
      .eq("id", sessionId);
    if (e2) throw e2;
  }
  return { ok: true, value: asHand(data) };
}

export async function updateHand(db: SupabaseClient, userId: string, id: string, raw: HandInput): Promise<Result<LiveHand>> {
  const hand = await getHand(db, userId, id);
  if (!hand) return { ok: false, error: "No such hand." };
  const session = await getSession(db, userId, hand.session_id);
  if (!session) return { ok: false, error: "No such session." };
  let input: HandInput;
  try {
    input = checkHand(raw, session.seats).input;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const { data, error } = await db
    .from("live_hands")
    .update(handRow(input))
    .eq("user_id", userId)
    .eq("id", id)
    .select(HAND_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, error: "No such hand." };
  return { ok: true, value: asHand(data) };
}

export async function patchHandFlags(
  db: SupabaseClient,
  userId: string,
  id: string,
  input: { starred?: boolean; notes?: string | null },
): Promise<Result> {
  const patch: Record<string, unknown> = {};
  if (input.starred !== undefined) patch.starred = Boolean(input.starred);
  if (input.notes !== undefined) {
    const notes = cleanLong(input.notes);
    const p = tooLong(notes, LIVE_LIMITS.maxHandNotes, "Notes");
    if (p) return { ok: false, error: p };
    patch.notes = notes;
  }
  if (!Object.keys(patch).length) return { ok: false, error: "Nothing to change." };
  const { error, count } = await db.from("live_hands").update(patch, { count: "exact" }).eq("user_id", userId).eq("id", id);
  if (error) throw error;
  if (!count) return { ok: false, error: "No such hand." };
  return { ok: true };
}

export async function removeHand(db: SupabaseClient, userId: string, id: string): Promise<Result> {
  const { error, count } = await db.from("live_hands").delete({ count: "exact" }).eq("user_id", userId).eq("id", id);
  if (error) throw error;
  if (!count) return { ok: false, error: "No such hand." };
  return { ok: true };
}

/* ------------------------------------------------------------- bundles */

export type SessionBundle = {
  session: LiveSession;
  events: SessionEvent[];
  seatEvents: SeatEvent[];
  hands: LiveHand[];
  players: PlayerSummary[];
  tags: LiveTag[];
  /** Notes on everyone who sat at this table during the session. */
  notes: PlayerNote[];
};

/** Everything the session screen needs, in one round of queries. */
export async function getSessionBundle(db: SupabaseClient, userId: string, id: string): Promise<SessionBundle | null> {
  const session = await getSession(db, userId, id);
  if (!session) return null;
  const [events, seatEvents, hands, players, tags] = await Promise.all([
    loadSessionEvents(db, userId, id),
    loadSeatEvents(db, userId, id),
    loadHands(db, userId, id),
    loadPlayers(db, userId),
    loadTags(db, userId),
  ]);
  const seated = [...new Set(seatEvents.map((e) => e.player_id).filter((x): x is string => Boolean(x)))];
  const notes = await loadNotes(db, userId, { playerIds: seated });
  return { session, events, seatEvents, hands, players, tags, notes };
}
