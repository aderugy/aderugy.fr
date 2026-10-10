"use server";

import { refresh } from "next/cache";
import { requireUser, fail, type ActionResult } from "@/server/auth";
import { unknownName, type HandInput, type SeatEventKind } from "@/lib/live/types";
import {
  addMoney as addMoneyRow,
  addNote as addNoteRow,
  createHand as createHandRow,
  createPlayer as createPlayerRow,
  endSession as endSessionRow,
  insertTag,
  logSeatEvent,
  mergePlayers as mergePlayersRow,
  moveButton as moveButtonRow,
  moveSeat as moveSeatRow,
  patchHandFlags,
  patchMoney,
  patchNote,
  patchPlayer,
  patchSession,
  patchTag,
  removeHand,
  removeNote,
  removePlayer,
  removeSeatEvent,
  removeSession,
  removeSessionEvent,
  removeTag,
  reopenSession as reopenSessionRow,
  replaceOccupant,
  seatUnknown as seatUnknownRow,
  setStack as setStackRow,
  setOccupant,
  setPlayerTags,
  startSession as startSessionRow,
  toggleBreak as toggleBreakRow,
  updateHand as updateHandRow,
  type NewSession,
  type SessionPatch,
} from "@/server/live/data";

// Thin wrappers: the rules live in server/live/data.ts and lib/live/, shared
// with the Claude connector where it is allowed to act.

type IdResult = { ok: true; id: string } | { ok: false; error: string };

/** Run, refresh the page on success, and turn a throw into a sentence. */
async function act(fn: (db: Awaited<ReturnType<typeof requireUser>>) => Promise<{ ok: boolean; error?: string }>): Promise<ActionResult> {
  try {
    const ctx = await requireUser();
    const r = await fn(ctx);
    if (!r.ok) return { ok: false, error: r.error ?? "Something went wrong" };
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/* -------------------------------------------------------------- sessions */

export async function startSession(input: NewSession): Promise<IdResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await startSessionRow(supabase, user.id, input);
    if (!r.ok) return r;
    refresh();
    return { ok: true, id: r.value.id };
  } catch (e) {
    return fail(e) as IdResult;
  }
}

export async function updateSession(id: string, patch: SessionPatch): Promise<ActionResult> {
  return act(({ supabase, user }) => patchSession(supabase, user.id, id, patch));
}

export async function endSession(id: string, input: { cash_out: number | string; ended_at?: string | null }): Promise<ActionResult> {
  return act(({ supabase, user }) => endSessionRow(supabase, user.id, id, input));
}

export async function reopenSession(id: string): Promise<ActionResult> {
  return act(({ supabase, user }) => reopenSessionRow(supabase, user.id, id));
}

export async function deleteSession(id: string): Promise<ActionResult> {
  return act(({ supabase, user }) => removeSession(supabase, user.id, id));
}

export async function addMoney(
  sessionId: string,
  input: { kind: "buy_in" | "rebuy"; amount: number | string; at?: string | null },
): Promise<ActionResult> {
  return act(({ supabase, user }) => addMoneyRow(supabase, user.id, sessionId, input));
}

export async function updateMoney(eventId: string, amount: number | string): Promise<ActionResult> {
  return act(({ supabase, user }) => patchMoney(supabase, user.id, eventId, amount));
}

export async function deleteSessionEvent(eventId: string): Promise<ActionResult> {
  return act(({ supabase, user }) => removeSessionEvent(supabase, user.id, eventId));
}

export async function toggleBreak(sessionId: string): Promise<ActionResult> {
  return act(({ supabase, user }) => toggleBreakRow(supabase, user.id, sessionId));
}

/* ------------------------------------------------------------- the table */

export async function seatEvent(
  sessionId: string,
  input: { kind: SeatEventKind; seat: number; player_id?: string | null },
): Promise<ActionResult> {
  return act(({ supabase, user }) => logSeatEvent(supabase, user.id, sessionId, input));
}

/** Someone new sits down: create them and seat them in one go. */
export async function seatNewPlayer(
  sessionId: string,
  seat: number,
  input: { name: string; description?: string | null; tag_ids?: string[] },
): Promise<IdResult> {
  try {
    const { supabase, user } = await requireUser();
    const created = await createPlayerRow(supabase, user.id, input);
    if (!created.ok) return created;
    const r = await logSeatEvent(supabase, user.id, sessionId, { kind: "sit", seat, player_id: created.value.id });
    if (!r.ok) return r;
    refresh();
    return { ok: true, id: created.value.id };
  } catch (e) {
    return fail(e) as IdResult;
  }
}

/** Name the person in a seat with a new player. */
export async function identifyAsNewPlayer(
  sessionId: string,
  seat: number,
  input: { name: string; description?: string | null; tag_ids?: string[] },
): Promise<IdResult> {
  try {
    const { supabase, user } = await requireUser();
    const created = await createPlayerRow(supabase, user.id, input);
    if (!created.ok) return created;
    const r = await setOccupant(supabase, user.id, sessionId, seat, created.value.id);
    if (!r.ok) return r;
    refresh();
    return { ok: true, id: created.value.id };
  } catch (e) {
    return fail(e) as IdResult;
  }
}

/** Someone nobody knows sits down: a fresh unknown player. */
export async function seatUnknown(sessionId: string, seat: number): Promise<ActionResult> {
  return act(({ supabase, user }) => seatUnknownRow(supabase, user.id, sessionId, seat));
}

/** The player leaves and someone new takes the seat at once. */
export async function replaceWithUnknown(sessionId: string, seat: number): Promise<ActionResult> {
  return act(({ supabase, user }) => replaceOccupant(supabase, user.id, sessionId, seat));
}

/** The wrong person was picked and nobody knows who it is: a fresh unknown for the whole stay. */
export async function identifyAsUnknown(sessionId: string, seat: number): Promise<ActionResult> {
  return act(async ({ supabase, user }) => {
    const created = await createPlayerRow(supabase, user.id, { name: unknownName(seat), known: false });
    if (!created.ok) return created;
    const r = await setOccupant(supabase, user.id, sessionId, seat, created.value.id);
    if (!r.ok) await removePlayer(supabase, user.id, created.value.id);
    return r;
  });
}

/** What a seat has in front of it now; empty clears it. */
export async function setStack(sessionId: string, seat: number, value: number | string | null): Promise<ActionResult> {
  return act(({ supabase, user }) => setStackRow(supabase, user.id, sessionId, seat, value));
}

/** Where the button is for the next hand: a seat, or one seat on. */
export async function moveButton(sessionId: string, to: number | "next"): Promise<ActionResult> {
  return act(({ supabase, user }) => moveButtonRow(supabase, user.id, sessionId, to));
}

export async function identifySeat(sessionId: string, seat: number, playerId: string): Promise<ActionResult> {
  return act(({ supabase, user }) => setOccupant(supabase, user.id, sessionId, seat, playerId));
}

export async function moveSeat(sessionId: string, from: number, to: number): Promise<ActionResult> {
  return act(({ supabase, user }) => moveSeatRow(supabase, user.id, sessionId, from, to));
}

export async function deleteSeatEvent(eventId: string): Promise<ActionResult> {
  return act(({ supabase, user }) => removeSeatEvent(supabase, user.id, eventId));
}

/* ---------------------------------------------------------------- players */

export async function createPlayer(input: { name: string; description?: string | null; tag_ids?: string[] }): Promise<IdResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await createPlayerRow(supabase, user.id, input);
    if (!r.ok) return r;
    refresh();
    return { ok: true, id: r.value.id };
  } catch (e) {
    return fail(e) as IdResult;
  }
}

export async function updatePlayer(id: string, input: { name?: string; description?: string | null }): Promise<ActionResult> {
  return act(({ supabase, user }) => patchPlayer(supabase, user.id, id, input));
}

/** An unknown gets a name and joins the known players. */
export async function promotePlayer(id: string, name: string): Promise<ActionResult> {
  return act(({ supabase, user }) => patchPlayer(supabase, user.id, id, { name, known: true }));
}

/**
 * "That unknown is Marco": everything on the unknown moves to Marco. From the
 * unknown's own page (`refreshPage: false`), the caller navigates away instead:
 * refreshing a page whose player was just deleted would show a 404.
 */
export async function mergePlayers(fromId: string, intoId: string, refreshPage = true): Promise<ActionResult> {
  if (refreshPage) return act(({ supabase, user }) => mergePlayersRow(supabase, user.id, fromId, intoId));
  try {
    const { supabase, user } = await requireUser();
    const r = await mergePlayersRow(supabase, user.id, fromId, intoId);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (e) {
    return fail(e);
  }
}

export async function deletePlayer(id: string): Promise<ActionResult> {
  return act(({ supabase, user }) => removePlayer(supabase, user.id, id));
}

export async function setTags(playerId: string, tagIds: string[]): Promise<ActionResult> {
  return act(({ supabase, user }) => setPlayerTags(supabase, user.id, playerId, tagIds));
}

export async function addNote(input: {
  player_id: string;
  body: string;
  session_id?: string | null;
  hand_id?: string | null;
}): Promise<ActionResult> {
  return act(({ supabase, user }) => addNoteRow(supabase, user.id, input));
}

export async function updateNote(id: string, body: string): Promise<ActionResult> {
  return act(({ supabase, user }) => patchNote(supabase, user.id, id, body));
}

export async function deleteNote(id: string): Promise<ActionResult> {
  return act(({ supabase, user }) => removeNote(supabase, user.id, id));
}

/* ------------------------------------------------------------------ tags */

export async function createTag(input: { name: string; color: string | null }): Promise<IdResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await insertTag(supabase, user.id, input);
    if (!r.ok) return r;
    refresh();
    return { ok: true, id: r.value.id };
  } catch (e) {
    return fail(e) as IdResult;
  }
}

export async function updateTag(id: string, input: { name?: string; color?: string | null; position?: number }): Promise<ActionResult> {
  return act(({ supabase, user }) => patchTag(supabase, user.id, id, input));
}

export async function deleteTag(id: string): Promise<ActionResult> {
  return act(({ supabase, user }) => removeTag(supabase, user.id, id));
}

/* ----------------------------------------------------------------- hands */

export async function createHand(sessionId: string, input: HandInput): Promise<IdResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await createHandRow(supabase, user.id, sessionId, input);
    if (!r.ok) return r;
    refresh();
    return { ok: true, id: r.value.id };
  } catch (e) {
    return fail(e) as IdResult;
  }
}

export async function updateHand(id: string, input: HandInput): Promise<ActionResult> {
  return act(({ supabase, user }) => updateHandRow(supabase, user.id, id, input));
}

export async function updateHandFlags(id: string, input: { starred?: boolean; notes?: string | null }): Promise<ActionResult> {
  return act(({ supabase, user }) => patchHandFlags(supabase, user.id, id, input));
}

export async function deleteHand(id: string): Promise<ActionResult> {
  return act(({ supabase, user }) => removeHand(supabase, user.id, id));
}
