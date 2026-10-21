import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysISO, dayEnd, dayStart, reviewDay } from "@/lib/flashcards/day";
import { deckPath, deckTree, findDeck, flatten, pathNames, subtreeIds } from "@/lib/flashcards/decks";
import { cardOrds, cleanNote, cleanTags, duplicateKey, type NoteInput } from "@/lib/flashcards/notes";
import { buildQueue, LEARN_AHEAD_MS, type Queue } from "@/lib/flashcards/queue";
import { schedule } from "@/lib/flashcards/scheduler";
import {
  CARD_COLUMNS,
  DECK_COLUMNS,
  DEFAULT_SETTINGS,
  LIMITS,
  NOTE_COLUMNS,
  memoryOf,
  type Card,
  type CardState,
  type Deck,
  type Note,
  type NoteKind,
  type Rating,
  type Settings,
} from "@/lib/flashcards/types";

/**
 * /flashcards persistence, shared by the pages' server actions and the Claude
 * connector, on the model of server/jobs/data.ts: every function takes the
 * client to act through (cookie-bound for the UI, bearer-token for Claude);
 * both run as the user under RLS, and the connector rules of migration 0023
 * apply without anything here having to know.
 *
 * Throws on database errors (as Error, with the database's message); returns
 * `{ ok: false }` for anything the caller should show as a sentence.
 */

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const no = (error: string): Result<never> => ({ ok: false, error });

type DbError = { message: string; code?: string } | null;

function check(error: DbError): void {
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
}

function attempt<T>(fn: () => T): Result<T> {
  try {
    return ok(fn());
  } catch (e) {
    return no(e instanceof Error ? e.message : String(e));
  }
}

/** PostgREST hands a to-one embed back as an object, sometimes as an array. */
function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** Escape LIKE wildcards so text is matched literally. */
function likeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** PostgREST returns at most 1 000 rows a request: page through. */
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: DbError }>,
  max = 50_000,
): Promise<T[]> {
  const size = 1000;
  const out: T[] = [];
  for (let from = 0; from < max; from += size) {
    const { data, error } = await page(from, from + size - 1);
    check(error);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

/* ---------------------------------------------------------------- settings */

type SettingsRow = {
  retention: number | string;
  new_per_day: number;
  reviews_per_day: number;
  learning_steps: number[];
  relearning_steps: number[];
  day_starts_hour: number;
  time_zone: string;
  leech_threshold: number;
  swipe_gestures: boolean;
};

export async function loadSettings(db: SupabaseClient, userId: string): Promise<Settings> {
  const { data, error } = await db
    .from("fc_settings")
    .select("retention, new_per_day, reviews_per_day, learning_steps, relearning_steps, day_starts_hour, time_zone, leech_threshold, swipe_gestures")
    .eq("user_id", userId)
    .maybeSingle();
  check(error);
  if (!data) return DEFAULT_SETTINGS;
  const r = data as SettingsRow;
  return {
    retention: Number(r.retention),
    newPerDay: r.new_per_day,
    reviewsPerDay: r.reviews_per_day,
    learningSteps: r.learning_steps,
    relearningSteps: r.relearning_steps,
    dayStartsHour: r.day_starts_hour,
    timeZone: r.time_zone,
    leechThreshold: r.leech_threshold,
    swipeGestures: r.swipe_gestures,
  };
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Check settings before saving. Throws a sentence. */
export function cleanSettings(s: Settings): Settings {
  const steps = (list: number[], what: string, min: number) => {
    const out = list.map(Number).filter((n) => Number.isFinite(n)).map((n) => Math.round(n));
    if (out.length < min || out.length > 8) throw new Error(`${what}: between ${min} and 8 steps.`);
    if (out.some((n) => n < 1 || n > 1440)) throw new Error(`${what}: each step is 1 to 1440 minutes.`);
    return out;
  };
  const int = (n: number, lo: number, hi: number, what: string) => {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${what}: ${lo} to ${hi}.`);
    return v;
  };
  const retention = Number(s.retention);
  if (!(retention >= 0.7 && retention <= 0.97)) throw new Error("Target retention: 70 % to 97 %.");
  if (!validTimeZone(s.timeZone)) throw new Error(`Unknown time zone "${s.timeZone}".`);
  return {
    retention: Math.round(retention * 1000) / 1000,
    newPerDay: int(s.newPerDay, 0, 9999, "New cards per day"),
    reviewsPerDay: int(s.reviewsPerDay, 0, 99999, "Reviews per day"),
    learningSteps: steps(s.learningSteps, "Learning steps", 1),
    relearningSteps: steps(s.relearningSteps, "Relearning steps", 0),
    dayStartsHour: int(s.dayStartsHour, 0, 23, "Day starts at"),
    timeZone: s.timeZone,
    leechThreshold: int(s.leechThreshold, 2, 99, "Leech threshold"),
    swipeGestures: Boolean(s.swipeGestures),
  };
}

export async function saveSettings(db: SupabaseClient, userId: string, input: Settings): Promise<Result> {
  const r = attempt(() => cleanSettings(input));
  if (!r.ok) return r;
  const s = r.value;
  const { error } = await db.from("fc_settings").upsert({
    user_id: userId,
    retention: s.retention,
    new_per_day: s.newPerDay,
    reviews_per_day: s.reviewsPerDay,
    learning_steps: s.learningSteps,
    relearning_steps: s.relearningSteps,
    day_starts_hour: s.dayStartsHour,
    time_zone: s.timeZone,
    leech_threshold: s.leechThreshold,
    swipe_gestures: s.swipeGestures,
  });
  check(error);
  return ok(undefined);
}

/* ------------------------------------------------------------------- decks */

export async function loadDecks(db: SupabaseClient, userId: string): Promise<Deck[]> {
  const { data, error } = await db.from("fc_decks").select(DECK_COLUMNS).eq("user_id", userId).order("position").order("name");
  check(error);
  return (data ?? []) as Deck[];
}

function deckError(e: unknown): string {
  const code = (e as { code?: string })?.code;
  if (code === "23505") return "A deck with that name already exists here.";
  return e instanceof Error ? e.message : String(e);
}

function cleanDeckName(name: string): string {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n) throw new Error("The deck needs a name.");
  if (n.length > LIMITS.deckName) throw new Error(`Deck names are at most ${LIMITS.deckName} characters.`);
  if (n.includes("::")) throw new Error('A deck name cannot contain "::" (it separates decks in a path).');
  return n;
}

export async function createDeck(
  db: SupabaseClient,
  userId: string,
  input: { name: string; parentId: string | null },
): Promise<Result<Deck>> {
  const name = attempt(() => cleanDeckName(input.name));
  if (!name.ok) return name;
  const { data, error } = await db
    .from("fc_decks")
    .insert({ user_id: userId, name: name.value, parent_id: input.parentId })
    .select(DECK_COLUMNS)
    .single();
  if (error) return no(deckError(Object.assign(new Error(error.message), { code: error.code })));
  return ok(data as Deck);
}

/** The deck at a path ("Maths::Lois"), creating whatever part of it is missing. */
export async function ensureDeckPath(db: SupabaseClient, userId: string, path: string, decks?: Deck[]): Promise<Result<Deck>> {
  const all = decks ?? (await loadDecks(db, userId));
  const names = pathNames(path);
  if (names.length === 0) return no("The deck path is empty.");
  let parent: Deck | null = null;
  for (let i = 0; i < names.length; i++) {
    const sub = names.slice(0, i + 1).join("::");
    const found = findDeck(all, sub);
    if (found) {
      parent = found;
      continue;
    }
    const created: Result<Deck> = await createDeck(db, userId, { name: names[i], parentId: parent?.id ?? null });
    if (!created.ok) return created;
    all.push(created.value);
    parent = created.value;
  }
  return ok(parent!);
}

export async function patchDeck(
  db: SupabaseClient,
  userId: string,
  id: string,
  patch: { name?: string; parentId?: string | null; position?: number },
): Promise<Result> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const n = attempt(() => cleanDeckName(patch.name!));
    if (!n.ok) return n;
    row.name = n.value;
  }
  if (patch.parentId !== undefined) {
    if (patch.parentId === id) return no("A deck cannot be inside itself.");
    row.parent_id = patch.parentId;
  }
  if (patch.position !== undefined) row.position = Math.round(patch.position);
  if (Object.keys(row).length === 0) return ok(undefined);
  const { error } = await db.from("fc_decks").update(row).eq("user_id", userId).eq("id", id);
  if (error) return no(deckError(Object.assign(new Error(error.message), { code: error.code })));
  return ok(undefined);
}

export async function deleteDeck(db: SupabaseClient, id: string, moveTo: string | null): Promise<Result> {
  const { error } = await db.rpc("fc_delete_deck", { p_id: id, p_move_to: moveTo });
  if (error) return no(error.message);
  return ok(undefined);
}

export type DeckCounts = {
  cards: number;
  newCards: number;
  learningDue: number;
  reviewDue: number;
  suspended: number;
};

export type DeckWithCounts = Deck & {
  path: string;
  depth: number;
  /** This deck and its sub-decks. */
  counts: DeckCounts;
  /** New and due cards past today's limits in this subtree. */
  beyond: number;
};

/**
 * Every deck with today's counts, rolled up over its subtree. New and review
 * counts are capped by what the daily limits still allow, as the session
 * would show them.
 */
export async function decksWithCounts(
  db: SupabaseClient,
  userId: string,
  now = new Date(),
): Promise<{
  decks: DeckWithCounts[];
  total: DeckCounts;
  /** What today's limits hold back over every deck: still studiable, after a warning. */
  beyond: { newCards: number; reviewDue: number };
  settings: Settings;
  doneToday: { reviews: number; fresh: number };
}> {
  const settings = await loadSettings(db, userId);
  const today = reviewDay(now, settings);
  const [decks, counts, done] = await Promise.all([
    loadDecks(db, userId),
    db.rpc("fc_deck_counts", {
      p_learn_cutoff: new Date(now.getTime() + LEARN_AHEAD_MS).toISOString(),
      p_day_end: dayEnd(now, settings).toISOString(),
      p_today: today,
    }),
    todaysRatings(db, userId, today),
  ]);
  check(counts.error);
  const own = new Map<string, DeckCounts>();
  for (const r of (counts.data ?? []) as {
    deck_id: string;
    cards: number;
    new_cards: number;
    learning_due: number;
    review_due: number;
    suspended: number;
  }[]) {
    own.set(r.deck_id, {
      cards: Number(r.cards),
      newCards: Number(r.new_cards),
      learningDue: Number(r.learning_due),
      reviewDue: Number(r.review_due),
      suspended: Number(r.suspended),
    });
  }
  const reviewsDone = done.filter((r) => r.state_before === "review").length;
  const freshDone = new Set(done.filter((r) => r.state_before === "new").map((r) => r.card_id)).size;
  const reviewRoom = Math.max(0, settings.reviewsPerDay - reviewsDone);
  const freshRoom = Math.max(0, settings.newPerDay - freshDone);

  const out: DeckWithCounts[] = flatten(deckTree(decks)).map((d) => {
    const sum: DeckCounts = { cards: 0, newCards: 0, learningDue: 0, reviewDue: 0, suspended: 0 };
    for (const id of subtreeIds(decks, d.id)) {
      const c = own.get(id);
      if (!c) continue;
      sum.cards += c.cards;
      sum.newCards += c.newCards;
      sum.learningDue += c.learningDue;
      sum.reviewDue += c.reviewDue;
      sum.suspended += c.suspended;
    }
    return {
      id: d.id,
      parent_id: d.parent_id,
      name: d.name,
      position: d.position,
      archived_at: d.archived_at,
      path: d.path,
      depth: d.depth,
      counts: { ...sum, newCards: Math.min(sum.newCards, freshRoom), reviewDue: Math.min(sum.reviewDue, reviewRoom) },
      beyond: Math.max(0, sum.newCards - freshRoom) + Math.max(0, sum.reviewDue - reviewRoom),
    };
  });
  const total: DeckCounts = { cards: 0, newCards: 0, learningDue: 0, reviewDue: 0, suspended: 0 };
  for (const c of own.values()) {
    total.cards += c.cards;
    total.newCards += c.newCards;
    total.learningDue += c.learningDue;
    total.reviewDue += c.reviewDue;
    total.suspended += c.suspended;
  }
  const beyond = {
    newCards: Math.max(0, total.newCards - freshRoom),
    reviewDue: Math.max(0, total.reviewDue - reviewRoom),
  };
  total.newCards = Math.min(total.newCards, freshRoom);
  total.reviewDue = Math.min(total.reviewDue, reviewRoom);
  return { decks: out, total, beyond, settings, doneToday: { reviews: reviewsDone, fresh: freshDone } };
}

/* ------------------------------------------------------------------- notes */

export type NoteWithCards = Note & { cards: Card[]; deck_path: string };

export async function getNote(db: SupabaseClient, userId: string, id: string): Promise<NoteWithCards | null> {
  const [{ data, error }, decks] = await Promise.all([
    db
      .from("fc_notes")
      .select(`${NOTE_COLUMNS}, fc_cards(${CARD_COLUMNS})`)
      .eq("user_id", userId)
      .eq("id", id)
      .maybeSingle(),
    loadDecks(db, userId),
  ]);
  check(error);
  if (!data) return null;
  const { fc_cards, ...note } = data as Note & { fc_cards: Card[] };
  return {
    ...(note as Note),
    cards: (fc_cards ?? []).sort((a, b) => a.ord - b.ord),
    deck_path: deckPath(decks, note.deck_id) ?? "?",
  };
}

/** Another live note in the deck with the same front (any case), if any. */
export async function findDuplicate(
  db: SupabaseClient,
  userId: string,
  deckId: string,
  front: string,
  excludeId?: string,
): Promise<{ id: string } | null> {
  const key = duplicateKey(front);
  if (!key) return null;
  // Narrow on the database with the first words, then compare exactly here.
  const probe = key.split(" ").slice(0, 3).join(" ");
  let q = db
    .from("fc_notes")
    .select("id, front")
    .eq("user_id", userId)
    .eq("deck_id", deckId)
    .is("deleted_at", null)
    .ilike("front", `%${likeLiteral(probe)}%`)
    .limit(200);
  if (excludeId) q = q.neq("id", excludeId);
  const { data, error } = await q;
  check(error);
  const hit = (data ?? []).find((n) => duplicateKey(n.front as string) === key);
  return hit ? { id: hit.id as string } : null;
}

/**
 * Make a note's cards match what it generates: add the missing ones as new
 * cards, delete those it no longer generates (with their history — the editor
 * asks first). Returns how many were removed.
 */
async function syncCards(
  db: SupabaseClient,
  userId: string,
  note: { id: string; kind: NoteKind; front: string; back: string },
): Promise<{ added: number; removed: number }> {
  const want = cardOrds(note);
  const { data, error } = await db.from("fc_cards").select("id, ord").eq("note_id", note.id);
  check(error);
  const have = (data ?? []) as { id: string; ord: number }[];
  const missing = want.filter((o) => !have.some((c) => c.ord === o));
  const extra = have.filter((c) => !want.includes(c.ord));
  if (missing.length) {
    const now = new Date().toISOString();
    const ins = await db
      .from("fc_cards")
      .insert(missing.map((ord) => ({ user_id: userId, note_id: note.id, ord, due: now })));
    check(ins.error);
  }
  if (extra.length) {
    const del = await db.from("fc_cards").delete().in("id", extra.map((c) => c.id));
    check(del.error);
  }
  return { added: missing.length, removed: extra.length };
}

/** Which existing cards an edit would delete (cloze gaps removed, kind changed). */
export function cardsLostBy(current: { kind: NoteKind; front: string; back: string; cards: { ord: number; reps: number }[] }, next: { kind: NoteKind; front: string; back: string }): number[] {
  const want = cardOrds(next);
  return current.cards.filter((c) => !want.includes(c.ord) && c.reps > 0).map((c) => c.ord);
}

export type SaveNoteInput = NoteInput & {
  deckId: string;
  /** New notes only: wait in the inbox, without cards, until accepted. Default false. */
  inbox?: boolean;
};

/**
 * Create or update a note. A new note gets its cards at once, unless it goes
 * to the inbox (Claude's notes, and only those, are forced there by the
 * database). Returns a duplicate warning without refusing.
 */
export async function saveNote(
  db: SupabaseClient,
  userId: string,
  input: SaveNoteInput & { id?: string },
  opts: { checkDuplicate?: boolean } = {},
): Promise<Result<{ id: string; duplicateOf: string | null; removedCards: number }>> {
  const clean = attempt(() => cleanNote(input));
  if (!clean.ok) return clean;
  const n = clean.value;
  const row = { deck_id: input.deckId, kind: n.kind, front: n.front, back: n.back, extra: n.extra, source: n.source, tags: n.tags };

  let id = input.id;
  let inbox = false;
  if (id) {
    const { data, error } = await db.from("fc_notes").update(row).eq("user_id", userId).eq("id", id).select("id, inbox").maybeSingle();
    if (error) return no(error.message);
    if (!data) return no("Note not found.");
    inbox = Boolean(data.inbox);
  } else {
    const { data, error } = await db
      .from("fc_notes")
      .insert({ ...row, user_id: userId, inbox: Boolean(input.inbox) })
      .select("id, inbox")
      .single();
    if (error) return no(error.message);
    id = data.id as string;
    inbox = Boolean(data.inbox);
  }

  const synced = inbox ? { removed: 0 } : await syncCards(db, userId, { id: id!, ...n });
  const dup = opts.checkDuplicate === false ? null : await findDuplicate(db, userId, input.deckId, n.front, id);
  return ok({ id: id!, duplicateOf: dup?.id ?? null, removedCards: synced.removed });
}

/** Notes waiting in the inbox (written by Claude), oldest first. */
export async function loadInbox(db: SupabaseClient, userId: string): Promise<Note[]> {
  const { data, error } = await db
    .from("fc_notes")
    .select(NOTE_COLUMNS)
    .eq("user_id", userId)
    .eq("inbox", true)
    .is("deleted_at", null)
    .order("created_at")
    .limit(500);
  check(error);
  return (data ?? []) as Note[];
}

/** Accept inbox notes: out of the inbox, and their cards are generated. */
export async function acceptNotes(db: SupabaseClient, userId: string, ids: string[]): Promise<Result<number>> {
  if (ids.length === 0) return ok(0);
  const { data, error } = await db
    .from("fc_notes")
    .update({ inbox: false })
    .eq("user_id", userId)
    .eq("inbox", true)
    .in("id", ids)
    .select("id, kind, front, back");
  check(error);
  for (const n of (data ?? []) as { id: string; kind: NoteKind; front: string; back: string }[]) {
    await syncCards(db, userId, n);
  }
  return ok((data ?? []).length);
}

/** Reject inbox notes: deleted outright (they never had cards). */
export async function rejectNotes(db: SupabaseClient, userId: string, ids: string[]): Promise<Result<number>> {
  if (ids.length === 0) return ok(0);
  const { data, error } = await db.from("fc_notes").delete().eq("user_id", userId).eq("inbox", true).in("id", ids).select("id");
  check(error);
  return ok((data ?? []).length);
}

export async function trashNotes(db: SupabaseClient, userId: string, ids: string[], trash: boolean): Promise<Result<number>> {
  const { data, error } = await db
    .from("fc_notes")
    .update({ deleted_at: trash ? new Date().toISOString() : null })
    .eq("user_id", userId)
    .in("id", ids)
    .select("id");
  check(error);
  return ok((data ?? []).length);
}

export async function deleteNotesForever(db: SupabaseClient, userId: string, ids: string[]): Promise<Result<number>> {
  const { data, error } = await db.from("fc_notes").delete().eq("user_id", userId).not("deleted_at", "is", null).in("id", ids).select("id");
  check(error);
  return ok((data ?? []).length);
}

export async function moveNotes(db: SupabaseClient, userId: string, ids: string[], deckId: string): Promise<Result<number>> {
  const { data, error } = await db.from("fc_notes").update({ deck_id: deckId }).eq("user_id", userId).in("id", ids).select("id");
  if (error) return no(error.message);
  return ok((data ?? []).length);
}

/** Add and remove tags on many notes. */
export async function retagNotes(
  db: SupabaseClient,
  userId: string,
  ids: string[],
  add: string[],
  remove: string[],
): Promise<Result<number>> {
  const a = attempt(() => cleanTags(add));
  if (!a.ok) return a;
  const drop = new Set(remove.map((t) => t.toLowerCase()));
  const { data, error } = await db.from("fc_notes").select("id, tags").eq("user_id", userId).in("id", ids);
  check(error);
  let n = 0;
  for (const row of (data ?? []) as { id: string; tags: string[] }[]) {
    const kept = row.tags.filter((t) => !drop.has(t.toLowerCase()));
    const next = attempt(() => cleanTags([...kept, ...a.value]));
    if (!next.ok) return next;
    if (next.value.join(" ") === row.tags.join(" ")) continue;
    const u = await db.from("fc_notes").update({ tags: next.value }).eq("id", row.id);
    check(u.error);
    n++;
  }
  return ok(n);
}

export async function renameTag(db: SupabaseClient, from: string, to: string): Promise<Result<number>> {
  const { data, error } = await db.rpc("fc_rename_tag", { p_from: from, p_to: to });
  if (error) return no(error.message);
  return ok(Number(data ?? 0));
}

export async function loadTags(db: SupabaseClient): Promise<{ tag: string; notes: number }[]> {
  const { data, error } = await db.rpc("fc_tags");
  check(error);
  return ((data ?? []) as { tag: string; notes: number }[]).map((r) => ({ tag: r.tag, notes: Number(r.notes) }));
}

/* ------------------------------------------------------------------ search */

export type SearchFilters = {
  q?: string;
  deckId?: string;
  tag?: string;
  kind?: NoteKind;
  state?: CardState | "suspended" | "flagged" | "leech";
  due?: "today" | "overdue";
  source?: boolean;
  createdBy?: "user" | "claude";
  trash?: boolean;
  /** Notes waiting in the inbox instead of accepted ones. */
  inbox?: boolean;
};

export type NoteRow = Note & { deck_path: string; cards: Card[] };

/**
 * Notes matching the filters, newest edit first, `limit` at a time. Card
 * filters (state, due, suspended, flagged) keep the notes with at least one
 * matching card.
 */
export async function searchNotes(
  db: SupabaseClient,
  userId: string,
  f: SearchFilters,
  page = 0,
  limit = 50,
  now = new Date(),
): Promise<{ notes: NoteRow[]; more: boolean }> {
  const [decks, settings] = await Promise.all([loadDecks(db, userId), loadSettings(db, userId)]);
  const cardFilter = Boolean(f.state && f.state !== "leech") || Boolean(f.due);
  let q = db
    .from("fc_notes")
    .select(`${NOTE_COLUMNS}, fc_cards${cardFilter ? "!inner" : ""}(${CARD_COLUMNS})`)
    .eq("user_id", userId)
    .eq("inbox", Boolean(f.inbox));
  q = f.trash ? q.not("deleted_at", "is", null) : q.is("deleted_at", null);
  if (f.deckId) q = q.in("deck_id", subtreeIds(decks, f.deckId));
  if (f.kind) q = q.eq("kind", f.kind);
  if (f.createdBy) q = q.eq("created_by", f.createdBy);
  if (f.source) q = q.not("source", "is", null);
  if (f.tag) {
    const tags = await loadTags(db);
    const key = f.tag.toLowerCase();
    const match = tags.map((t) => t.tag).filter((t) => t.toLowerCase() === key || t.toLowerCase().startsWith(`${key}::`));
    q = q.overlaps("tags", match.length ? match : [f.tag]);
  }
  if (f.state === "leech") q = q.contains("tags", ["leech"]);
  if (f.q?.trim()) {
    const words = f.q.trim().split(/\s+/).slice(0, 6);
    for (const w of words) {
      // Quoted for PostgREST's logic syntax, so commas and brackets are literal.
      const pat = `"%${likeLiteral(w).replace(/["\\]/g, (c) => `\\${c}`)}%"`;
      q = q.or(`front.ilike.${pat},back.ilike.${pat},extra.ilike.${pat}`);
    }
  }
  if (f.state === "suspended") q = q.eq("fc_cards.suspended", true);
  else if (f.state === "flagged") q = q.eq("fc_cards.flagged", true);
  else if (f.state && f.state !== "leech") q = q.eq("fc_cards.state", f.state);
  if (f.due) {
    const bound = f.due === "today" ? dayEnd(now, settings) : dayStart(reviewDay(now, settings), settings);
    q = q.neq("fc_cards.state", "new").eq("fc_cards.suspended", false).lt("fc_cards.due", bound.toISOString());
  }
  const { data, error } = await q.order("updated_at", { ascending: false }).range(page * limit, page * limit + limit);
  check(error);
  const rows = (data ?? []) as (Note & { fc_cards: Card[] })[];
  const notes = rows.slice(0, limit).map(({ fc_cards, ...n }) => ({
    ...(n as Note),
    cards: (fc_cards ?? []).sort((a, b) => a.ord - b.ord),
    deck_path: deckPath(decks, n.deck_id) ?? "?",
  }));
  return { notes, more: rows.length > limit };
}

/* ------------------------------------------------------------------ review */

export type QueueItem = {
  card: Card;
  note: Pick<Note, "id" | "deck_id" | "kind" | "front" | "back" | "extra" | "source" | "tags">;
  deckPath: string;
};

type CardWithNote = Card & {
  created_at: string;
  fc_notes: Pick<Note, "id" | "deck_id" | "kind" | "front" | "back" | "extra" | "source" | "tags"> | Note[] | null;
};

const QUEUE_SELECT = `${CARD_COLUMNS}, created_at, fc_notes!inner(id, deck_id, kind, front, back, extra, source, tags)`;

async function todaysRatings(db: SupabaseClient, userId: string, day: string) {
  return fetchAll<{ card_id: string; note_id: string; state_before: string }>((from, to) =>
    db
      .from("fc_reviews")
      .select("card_id, note_id, state_before")
      .eq("user_id", userId)
      .eq("review_day", day)
      .eq("kind", "review")
      .order("id")
      .range(from, to),
  );
}

export type Session = {
  settings: Settings;
  queue: { learning: QueueItem[]; review: QueueItem[]; fresh: QueueItem[] };
  heldBack: Queue["heldBack"];
  /** Cards past today's limits, offered at the end of the session (never in cram). */
  extra: { review: QueueItem[]; fresh: QueueItem[] };
  deckName: string | null;
  today: string;
};

/** Build a review session for a deck subtree (or every deck). */
export async function loadSession(
  db: SupabaseClient,
  userId: string,
  opts: { deckId?: string | null; now?: Date },
): Promise<Session> {
  const now = opts.now ?? new Date();
  const [settings, decks] = await Promise.all([loadSettings(db, userId), loadDecks(db, userId)]);
  const today = reviewDay(now, settings);
  const deckIds = opts.deckId ? subtreeIds(decks, opts.deckId) : null;

  const base = () => {
    let q = db.from("fc_cards").select(QUEUE_SELECT).eq("user_id", userId).eq("suspended", false).is("fc_notes.deleted_at", null);
    if (deckIds) q = q.in("fc_notes.deck_id", deckIds);
    return q;
  };
  const end = dayEnd(now, settings).toISOString();
  const [learning, reviews, fresh, ratings] = await Promise.all([
    fetchAll<CardWithNote>((a, b) =>
      base()
        .in("state", ["learning", "relearning"])
        .lte("due", new Date(now.getTime() + LEARN_AHEAD_MS).toISOString())
        .order("due")
        .range(a, b),
    ),
    fetchAll<CardWithNote>((a, b) => base().eq("state", "review").lt("due", end).order("due").range(a, b)),
    // A generous slice of new cards: siblings and buried cards are skipped later.
    fetchAll<CardWithNote>(
      (a, b) => base().eq("state", "new").order("created_at").order("ord").range(a, b),
      Math.max(1000, settings.newPerDay * 4),
    ),
    todaysRatings(db, userId, today),
  ]);

  const all = [...learning, ...reviews, ...fresh];
  const notes = new Map<string, QueueItem["note"]>();
  for (const c of all) {
    const n = one(c.fc_notes as QueueItem["note"] | QueueItem["note"][] | null);
    if (n) notes.set(c.note_id, n);
  }
  const cards = all.map((c) => {
    const { fc_notes, created_at, ...card } = c;
    void fc_notes;
    return { ...(card as Card), note_created_at: created_at };
  });
  const q = buildQueue({ cards, today: ratings, settings, now });
  const paths = new Map(flatten(deckTree(decks)).map((d) => [d.id, d.path]));
  const item = (c: Card): QueueItem => {
    const note = notes.get(c.note_id)!;
    return { card: c, note, deckPath: paths.get(note.deck_id) ?? "?" };
  };
  return {
    settings,
    queue: { learning: q.learning.map(item), review: q.review.map(item), fresh: q.fresh.map(item) },
    heldBack: q.heldBack,
    extra: { review: q.extra.review.map(item), fresh: q.extra.fresh.map(item) },
    deckName: opts.deckId ? (paths.get(opts.deckId) ?? null) : null,
    today,
  };
}

/** A cram session: every card of the selection that is not suspended, due first. */
export async function loadCram(
  db: SupabaseClient,
  userId: string,
  opts: { deckId?: string | null; tag?: string | null; now?: Date },
): Promise<Session> {
  const now = opts.now ?? new Date();
  const [settings, decks] = await Promise.all([loadSettings(db, userId), loadDecks(db, userId)]);
  let tags: string[] | null = null;
  if (opts.tag) {
    const key = opts.tag.toLowerCase();
    tags = (await loadTags(db)).map((t) => t.tag).filter((t) => t.toLowerCase() === key || t.toLowerCase().startsWith(`${key}::`));
    if (tags.length === 0) tags = [opts.tag];
  }
  const deckIds = opts.deckId ? subtreeIds(decks, opts.deckId) : null;
  const rows = await fetchAll<CardWithNote>(
    (a, b) => {
      let q = db.from("fc_cards").select(QUEUE_SELECT).eq("user_id", userId).eq("suspended", false).is("fc_notes.deleted_at", null);
      if (deckIds) q = q.in("fc_notes.deck_id", deckIds);
      if (tags) q = q.overlaps("fc_notes.tags", tags);
      return q.order("due").range(a, b);
    },
    2000,
  );
  const paths = new Map(flatten(deckTree(decks)).map((d) => [d.id, d.path]));
  const items: QueueItem[] = rows.map((c) => {
    const { fc_notes, created_at, ...card } = c;
    void created_at;
    const note = one(fc_notes as QueueItem["note"] | QueueItem["note"][] | null)!;
    return { card: card as Card, note, deckPath: paths.get(note.deck_id) ?? "?" };
  });
  const label = [opts.deckId ? paths.get(opts.deckId) : null, opts.tag ? `#${opts.tag}` : null].filter(Boolean).join(" · ");
  return {
    settings,
    queue: { learning: [], review: items, fresh: [] },
    heldBack: { review: 0, fresh: 0 },
    extra: { review: [], fresh: [] },
    deckName: label || null,
    today: reviewDay(now, settings),
  };
}

export type RateResult =
  | { ok: true; reviewId: number; card: Card }
  | { ok: false; stale: true }
  | { ok: false; stale?: false; error: string };

/**
 * Rate a card: the scheduler runs here, on the card as stored, and the RPC
 * writes the new state with its journal line. If another device rated the
 * card in between, the RPC refuses and the caller drops it from its queue.
 */
export async function rateCard(
  db: SupabaseClient,
  userId: string,
  input: { cardId: string; rating: Rating; durationMs: number; cram?: boolean },
  now = new Date(),
): Promise<RateResult> {
  const [settings, { data, error }] = await Promise.all([
    loadSettings(db, userId),
    db.from("fc_cards").select(CARD_COLUMNS).eq("user_id", userId).eq("id", input.cardId).maybeSingle(),
  ]);
  check(error);
  if (!data) return { ok: false, error: "Card not found." };
  const card = data as Card;
  const out = schedule(memoryOf(card), input.rating, now, settings);
  const m = out.memory;
  const r = await db.rpc("fc_save_review", {
    p_card_id: card.id,
    p_expected_reps: card.reps,
    p_kind: input.cram ? "cram" : "review",
    p_rating: input.rating,
    p_review_day: reviewDay(now, settings),
    p_duration_ms: Math.max(0, Math.min(60_000, Math.round(input.durationMs))),
    p_elapsed_days: out.elapsedDays,
    p_state: m.state,
    p_step: m.step,
    p_stability: m.stability,
    p_difficulty: m.difficulty,
    p_due: m.due,
    p_last_review: m.lastReview,
    p_reps: m.reps,
    p_lapses: m.lapses,
    p_leech: out.leech,
  });
  if (r.error) {
    if (r.error.code === "FC001") return { ok: false, stale: true };
    return { ok: false, error: r.error.message };
  }
  if (input.cram) return { ok: true, reviewId: Number(r.data), card };
  return {
    ok: true,
    reviewId: Number(r.data),
    card: {
      ...card,
      state: m.state,
      step: m.step,
      stability: m.stability,
      difficulty: m.difficulty,
      due: m.due,
      last_review: m.lastReview,
      reps: m.reps,
      lapses: m.lapses,
      suspended: card.suspended || out.leech,
      buried_until: null,
    },
  };
}

/** Undo a rating; returns the card as it is again, with its note, to put back in the queue. */
export async function undoReview(db: SupabaseClient, userId: string, reviewId: number): Promise<Result<QueueItem>> {
  const { data: cardId, error } = await db.rpc("fc_undo_review", { p_review_id: reviewId });
  if (error) return no(error.message);
  const [{ data, error: e2 }, decks] = await Promise.all([
    db.from("fc_cards").select(QUEUE_SELECT).eq("user_id", userId).eq("id", cardId as string).single(),
    loadDecks(db, userId),
  ]);
  check(e2);
  const { fc_notes, created_at, ...card } = data as CardWithNote;
  void created_at;
  const note = one(fc_notes as QueueItem["note"] | QueueItem["note"][] | null)!;
  return ok({ card: card as Card, note, deckPath: deckPath(decks, note.deck_id) ?? "?" });
}

export type CardPatch = {
  suspended?: boolean;
  flagged?: boolean;
  bury?: boolean;
  /** Forget the card: back to new, its history kept in the journal. */
  reset?: boolean;
  /** Review day ("YYYY-MM-DD") the card is next due; puts a card in steps back in review. */
  dueDay?: string;
};

/**
 * Suspend, flag, bury, reset or reschedule one card. Burying lasts until the
 * next review day. A new card cannot be given a due date: it is introduced by
 * the daily limit.
 */
export async function patchCard(
  db: SupabaseClient,
  userId: string,
  id: string,
  patch: CardPatch,
  now = new Date(),
): Promise<Result> {
  const row: Record<string, unknown> = {};
  if (patch.suspended !== undefined) row.suspended = patch.suspended;
  if (patch.flagged !== undefined) row.flagged = patch.flagged;
  const settings = patch.bury !== undefined || patch.dueDay ? await loadSettings(db, userId) : null;
  if (patch.bury !== undefined) row.buried_until = patch.bury ? reviewDay(now, settings!) : null;
  if (patch.reset && patch.dueDay) return no("Reset or reschedule a card, not both.");
  if (patch.reset) {
    Object.assign(row, {
      state: "new",
      step: 0,
      stability: 0,
      difficulty: 0,
      due: now.toISOString(),
      last_review: null,
      reps: 0,
      lapses: 0,
      buried_until: null,
    });
  }
  if (patch.dueDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.dueDay) || Number.isNaN(Date.parse(`${patch.dueDay}T00:00:00Z`))) {
      return no(`"${patch.dueDay}" is not a date (YYYY-MM-DD).`);
    }
    const { data, error } = await db.from("fc_cards").select("state, stability").eq("user_id", userId).eq("id", id).maybeSingle();
    check(error);
    if (!data) return no("Card not found.");
    if (data.state === "new" || Number(data.stability) <= 0) return no("A new card has no due date yet: it comes in with the daily new-card limit.");
    row.due = dayStart(patch.dueDay, settings!).toISOString();
    if (data.state !== "review") {
      row.state = "review";
      row.step = 0;
    }
  }
  if (Object.keys(row).length === 0) return ok(undefined);
  const { data, error } = await db.from("fc_cards").update(row).eq("user_id", userId).eq("id", id).select("id");
  check(error);
  if (!data?.length) return no("Card not found.");
  return ok(undefined);
}

/** Every rating of one card, newest first. */
export async function cardHistory(db: SupabaseClient, userId: string, cardIds: string[]) {
  if (cardIds.length === 0) return [];
  const { data, error } = await db
    .from("fc_reviews")
    .select("id, card_id, kind, rating, review_day, duration_ms, state_before, state_after, stability_after, due_after, reviewed_at")
    .eq("user_id", userId)
    .in("card_id", cardIds)
    .order("id", { ascending: false })
    .limit(500);
  check(error);
  return (data ?? []) as {
    id: number;
    card_id: string;
    kind: "review" | "cram";
    rating: Rating;
    review_day: string;
    duration_ms: number;
    state_before: CardState;
    state_after: CardState;
    stability_after: number;
    due_after: string;
    reviewed_at: string;
  }[];
}

/* ------------------------------------------------------------------- stats */

export type DayStat = {
  day: string;
  reviews: number;
  cram: number;
  ms: number;
  newCards: number;
  pass: number;
  total: number;
};

export type Stats = {
  settings: Settings;
  today: string;
  days: DayStat[];
  forecast: { day: string; cards: number }[];
  streak: number;
  states: Record<CardState | "suspended", number>;
  hardest: { card: Card; note: Pick<Note, "id" | "front" | "kind" | "back" | "tags">; deckPath: string }[];
  deckName: string | null;
};

export async function loadStats(
  db: SupabaseClient,
  userId: string,
  opts: { deckId?: string | null; now?: Date },
): Promise<Stats> {
  const now = opts.now ?? new Date();
  const [settings, decks] = await Promise.all([loadSettings(db, userId), loadDecks(db, userId)]);
  const today = reviewDay(now, settings);
  const deckIds = opts.deckId ? subtreeIds(decks, opts.deckId) : null;

  const cardsQuery = () => {
    let q = db
      .from("fc_cards")
      .select("id, fc_notes!inner(deck_id, deleted_at)", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("fc_notes.deleted_at", null);
    if (deckIds) q = q.in("fc_notes.deck_id", deckIds);
    return q;
  };
  const countCards = (fn: (q: ReturnType<typeof cardsQuery>) => ReturnType<typeof cardsQuery>) =>
    fn(cardsQuery()).then((r) => {
      check(r.error);
      return r.count ?? 0;
    });

  const hardestQuery = () => {
    let q = db
      .from("fc_cards")
      .select(`${CARD_COLUMNS}, fc_notes!inner(id, deck_id, front, back, kind, tags, deleted_at)`)
      .eq("user_id", userId)
      .is("fc_notes.deleted_at", null)
      .gt("reps", 0)
      .order("lapses", { ascending: false })
      .order("difficulty", { ascending: false })
      .limit(20);
    if (deckIds) q = q.in("fc_notes.deck_id", deckIds);
    return q;
  };

  const [daily, forecast, nNew, nLearning, nReview, nRelearning, nSuspended, hardest] = await Promise.all([
    db.rpc("fc_daily_stats", { p_from: addDaysISO(today, -371), p_to: today, p_deck_ids: deckIds }),
    db.rpc("fc_forecast", {
      p_today: today,
      p_days: 30,
      p_tz: settings.timeZone,
      p_day_start: settings.dayStartsHour,
      p_deck_ids: deckIds,
    }),
    countCards((q) => q.eq("state", "new").eq("suspended", false)),
    countCards((q) => q.eq("state", "learning").eq("suspended", false)),
    countCards((q) => q.eq("state", "review").eq("suspended", false)),
    countCards((q) => q.eq("state", "relearning").eq("suspended", false)),
    countCards((q) => q.eq("suspended", true)),
    hardestQuery(),
  ]);
  check(daily.error);
  check(forecast.error);
  check(hardest.error);

  const days: DayStat[] = ((daily.data ?? []) as Record<string, number | string>[]).map((r) => ({
    day: String(r.review_day),
    reviews: Number(r.reviews),
    cram: Number(r.cram),
    ms: Number(r.ms),
    newCards: Number(r.new_cards),
    pass: Number(r.retention_pass),
    total: Number(r.retention_total),
  }));

  // Consecutive days with at least one rating, ending today (or yesterday if
  // today has none yet: the streak is not broken before the day is over).
  const active = new Set(days.filter((d) => d.reviews + d.cram > 0).map((d) => d.day));
  let streak = 0;
  let cursor = active.has(today) ? today : addDaysISO(today, -1);
  while (active.has(cursor)) {
    streak++;
    cursor = addDaysISO(cursor, -1);
  }

  const paths = new Map(flatten(deckTree(decks)).map((d) => [d.id, d.path]));
  return {
    settings,
    today,
    days,
    forecast: ((forecast.data ?? []) as { day: string; cards: number }[]).map((r) => ({ day: String(r.day), cards: Number(r.cards) })),
    streak,
    states: { new: nNew, learning: nLearning, review: nReview, relearning: nRelearning, suspended: nSuspended },
    hardest: ((hardest.data ?? []) as (Card & { fc_notes: unknown })[]).map(({ fc_notes, ...c }) => {
      const n = one(fc_notes as (Pick<Note, "id" | "front" | "kind" | "back" | "tags"> & { deck_id: string }) | null)!;
      return { card: c as Card, note: { id: n.id, front: n.front, back: n.back, kind: n.kind, tags: n.tags }, deckPath: paths.get(n.deck_id) ?? "?" };
    }),
    deckName: opts.deckId ? (paths.get(opts.deckId) ?? null) : null,
  };
}

/* ------------------------------------------------------------ import/export */

export type ImportRow = {
  front: string;
  back: string;
  extra?: string;
  tags?: string;
  kind?: NoteKind;
  /** Deck path from a column; falls back to the deck chosen for the import. */
  deck?: string;
  source?: string;
};

export type ImportReport = { created: number; updated: number; skipped: number; errors: { row: number; error: string }[] };

/**
 * Import notes. Duplicates (same front in the same deck) are skipped,
 * updated in place or created anyway, as chosen.
 */
export async function importNotes(
  db: SupabaseClient,
  userId: string,
  rows: ImportRow[],
  opts: { deckId: string; kind: NoteKind; duplicates: "skip" | "update" | "create"; tags?: string },
): Promise<Result<ImportReport>> {
  if (rows.length > LIMITS.importRows) return no(`At most ${LIMITS.importRows} rows per import.`);
  const decks = await loadDecks(db, userId);
  if (!decks.some((d) => d.id === opts.deckId)) return no("Deck not found.");
  const extraTags = attempt(() => cleanTags(opts.tags ?? ""));
  if (!extraTags.ok) return extraTags;
  const report: ImportReport = { created: 0, updated: 0, skipped: 0, errors: [] };

  // Existing fronts per deck, to spot duplicates without a query per row.
  const existing = new Map<string, Map<string, string>>();
  const frontsOf = async (deckId: string) => {
    let m = existing.get(deckId);
    if (!m) {
      const rowsInDeck = await fetchAll<{ id: string; front: string }>((a, b) =>
        db.from("fc_notes").select("id, front").eq("user_id", userId).eq("deck_id", deckId).is("deleted_at", null).range(a, b),
      );
      m = new Map(rowsInDeck.map((n) => [duplicateKey(n.front), n.id]));
      existing.set(deckId, m);
    }
    return m;
  };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let deckId = opts.deckId;
    if (r.deck?.trim()) {
      const d = await ensureDeckPath(db, userId, r.deck, decks);
      if (!d.ok) {
        report.errors.push({ row: i + 1, error: d.error });
        continue;
      }
      deckId = d.value.id;
    }
    const note = attempt(() =>
      cleanNote({
        kind: r.kind ?? opts.kind,
        front: r.front ?? "",
        back: r.back ?? "",
        extra: r.extra,
        source: r.source,
        tags: [...(r.tags ? r.tags.split(/[\s,]+/) : []), ...extraTags.value],
      }),
    );
    if (!note.ok) {
      report.errors.push({ row: i + 1, error: note.error });
      continue;
    }
    const fronts = await frontsOf(deckId);
    const key = duplicateKey(note.value.front);
    const dup = fronts.get(key);
    if (dup && opts.duplicates === "skip") {
      report.skipped++;
      continue;
    }
    const saved = await saveNote(
      db,
      userId,
      { ...note.value, deckId, id: dup && opts.duplicates === "update" ? dup : undefined },
      { checkDuplicate: false },
    );
    if (!saved.ok) {
      report.errors.push({ row: i + 1, error: saved.error });
      continue;
    }
    fronts.set(key, saved.value.id);
    if (dup && opts.duplicates === "update") report.updated++;
    else report.created++;
  }
  return ok(report);
}

/** Every live note of a deck subtree (or of all decks), with deck paths, for export. */
export async function exportNotes(db: SupabaseClient, userId: string, deckId: string | null) {
  const decks = await loadDecks(db, userId);
  const ids = deckId ? subtreeIds(decks, deckId) : null;
  const notes = await fetchAll<Note & { fc_cards: Card[] }>((a, b) => {
    let q = db.from("fc_notes").select(`${NOTE_COLUMNS}, fc_cards(${CARD_COLUMNS})`).eq("user_id", userId).is("deleted_at", null).eq("inbox", false);
    if (ids) q = q.in("deck_id", ids);
    return q.order("created_at").range(a, b);
  });
  const reviews = await fetchAll<Record<string, unknown>>((a, b) => {
    let q = db
      .from("fc_reviews")
      .select("id, card_id, note_id, deck_id, kind, rating, review_day, duration_ms, elapsed_days, before, state_after, stability_after, difficulty_after, due_after, reviewed_at")
      .eq("user_id", userId);
    if (ids) q = q.in("deck_id", ids);
    return q.order("id").range(a, b);
  }, 500_000);
  const paths = new Map(flatten(deckTree(decks)).map((d) => [d.id, d.path]));
  return { notes, reviews, paths, decks };
}

/* ------------------------------------------------------------------- media */

const MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export async function saveMedia(db: SupabaseClient, userId: string, bytes: Uint8Array, mime: string): Promise<Result<string>> {
  if (!MEDIA_TYPES.includes(mime)) return no("Only PNG, JPEG, WebP and GIF images.");
  if (bytes.byteLength === 0 || bytes.byteLength > LIMITS.mediaBytes) return no("Images are at most 1 MB.");
  // bytea over PostgREST: hex text.
  const hex = `\\x${Buffer.from(bytes).toString("hex")}`;
  const { data, error } = await db.from("fc_media").insert({ user_id: userId, mime, bytes: hex }).select("id").single();
  if (error) return no(error.message);
  return ok(data.id as string);
}

export async function loadMedia(db: SupabaseClient, userId: string, id: string): Promise<{ mime: string; bytes: Buffer } | null> {
  const { data, error } = await db.from("fc_media").select("mime, bytes").eq("user_id", userId).eq("id", id).maybeSingle();
  check(error);
  if (!data) return null;
  const raw = String(data.bytes);
  const bytes = raw.startsWith("\\x") ? Buffer.from(raw.slice(2), "hex") : Buffer.from(raw, "base64");
  return { mime: String(data.mime), bytes };
}

/** Cards due on the next review day (overdue ones excluded), for the end of a session. */
export async function dueTomorrow(db: SupabaseClient, userId: string, deckId: string | null, now = new Date()): Promise<number> {
  const [settings, decks] = await Promise.all([loadSettings(db, userId), loadDecks(db, userId)]);
  const today = reviewDay(now, settings);
  const { data, error } = await db.rpc("fc_forecast", {
    p_today: today,
    p_days: 2,
    p_tz: settings.timeZone,
    p_day_start: settings.dayStartsHour,
    p_deck_ids: deckId ? subtreeIds(decks, deckId) : null,
  });
  check(error);
  const tomorrow = addDaysISO(today, 1);
  return Number(((data ?? []) as { day: string; cards: number }[]).find((r) => String(r.day) === tomorrow)?.cards ?? 0);
}
