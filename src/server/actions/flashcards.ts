"use server";

import { refresh } from "next/cache";
import { requireUser, fail, type ActionResult } from "@/server/auth";
import {
  acceptNotes as acceptNotesRow,
  createDeck as createDeckRow,
  deleteDeck as deleteDeckRow,
  deleteNotesForever as deleteForeverRows,
  ensureDeckPath,
  importNotes as importNotesRows,
  moveNotes as moveNotesRows,
  patchCard as patchCardRow,
  patchDeck as patchDeckRow,
  rateCard as rateCardRow,
  rejectNotes as rejectNotesRows,
  renameTag as renameTagRows,
  retagNotes as retagNotesRows,
  saveMedia,
  saveNote as saveNoteRow,
  saveSettings as saveSettingsRow,
  searchNotes as searchNotesRows,
  trashNotes as trashNotesRows,
  undoReview as undoReviewRow,
  findDuplicate,
  dueTomorrow as dueTomorrowCount,
  type ImportReport,
  type ImportRow,
  type NoteRow,
  type QueueItem,
  type RateResult,
  type SaveNoteInput,
  type SearchFilters,
} from "@/server/flashcards/data";
import type { NoteKind, Rating, Settings } from "@/lib/flashcards/types";

// Thin wrappers: the rules live in server/flashcards/data.ts, shared with the
// Claude connector where it is allowed to act.

type Value<T> = { ok: true; value: T } | { ok: false; error: string };

function failed<T>(e: unknown): Value<T> {
  return fail(e) as Value<T>;
}

/* ------------------------------------------------------------------ decks */

export async function createDeck(name: string, parentId: string | null): Promise<Value<string>> {
  try {
    const { supabase, user } = await requireUser();
    const r = await createDeckRow(supabase, user.id, { name, parentId });
    if (!r.ok) return r;
    refresh();
    return { ok: true, value: r.value.id };
  } catch (e) {
    return failed(e);
  }
}

export async function updateDeck(id: string, patch: { name?: string; parentId?: string | null; position?: number }): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await patchDeckRow(supabase, user.id, id, patch);
    if (!r.ok) return r;
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteDeck(id: string, moveTo: string | null): Promise<ActionResult> {
  try {
    const { supabase } = await requireUser();
    const r = await deleteDeckRow(supabase, id, moveTo);
    if (!r.ok) return r;
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/* ------------------------------------------------------------------ notes */

export async function saveNote(
  input: SaveNoteInput & { id?: string; deckPath?: string },
): Promise<Value<{ id: string; duplicateOf: string | null; removedCards: number }>> {
  try {
    const { supabase, user } = await requireUser();
    let deckId = input.deckId;
    if (!deckId && input.deckPath) {
      const d = await ensureDeckPath(supabase, user.id, input.deckPath);
      if (!d.ok) return d;
      deckId = d.value.id;
    }
    if (!deckId) return { ok: false, error: "Pick a deck." };
    const r = await saveNoteRow(supabase, user.id, { ...input, deckId });
    if (!r.ok) return r;
    refresh();
    return r;
  } catch (e) {
    return failed(e);
  }
}

/** Warn about a duplicate while the note is being written. */
export async function checkDuplicate(deckId: string, front: string, excludeId?: string): Promise<string | null> {
  try {
    const { supabase, user } = await requireUser();
    return (await findDuplicate(supabase, user.id, deckId, front, excludeId))?.id ?? null;
  } catch {
    return null;
  }
}

export async function searchNotes(filters: SearchFilters, page: number): Promise<Value<{ notes: NoteRow[]; more: boolean }>> {
  try {
    const { supabase, user } = await requireUser();
    return { ok: true, value: await searchNotesRows(supabase, user.id, filters, page) };
  } catch (e) {
    return failed(e);
  }
}

type Bulk =
  | { op: "trash" }
  | { op: "restore" }
  | { op: "destroy" }
  | { op: "move"; deckId: string }
  | { op: "tag"; add: string[]; remove: string[] }
  | { op: "accept" }
  | { op: "reject" };

/** One action on many notes: browse and inbox selections. */
export async function bulkNotes(ids: string[], action: Bulk): Promise<Value<number>> {
  try {
    if (ids.length === 0) return { ok: true, value: 0 };
    if (ids.length > 1000) return { ok: false, error: "At most 1000 notes at a time." };
    const { supabase, user } = await requireUser();
    let r: Value<number>;
    switch (action.op) {
      case "trash":
        r = await trashNotesRows(supabase, user.id, ids, true);
        break;
      case "restore":
        r = await trashNotesRows(supabase, user.id, ids, false);
        break;
      case "destroy":
        r = await deleteForeverRows(supabase, user.id, ids);
        break;
      case "move":
        r = await moveNotesRows(supabase, user.id, ids, action.deckId);
        break;
      case "tag":
        r = await retagNotesRows(supabase, user.id, ids, action.add, action.remove);
        break;
      case "accept":
        r = await acceptNotesRow(supabase, user.id, ids);
        break;
      case "reject":
        r = await rejectNotesRows(supabase, user.id, ids);
        break;
    }
    if (r.ok) refresh();
    return r;
  } catch (e) {
    return failed(e);
  }
}

export async function renameTag(from: string, to: string): Promise<Value<number>> {
  try {
    const { supabase } = await requireUser();
    const r = await renameTagRows(supabase, from, to);
    if (r.ok) refresh();
    return r;
  } catch (e) {
    return failed(e);
  }
}

/* ----------------------------------------------------------------- review */

/** No refresh(): the review page keeps its own queue. */
export async function rateCard(cardId: string, rating: Rating, durationMs: number, cram = false): Promise<RateResult> {
  try {
    const { supabase, user } = await requireUser();
    return await rateCardRow(supabase, user.id, { cardId, rating, durationMs, cram });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong" };
  }
}

export async function undoReview(reviewId: number): Promise<Value<QueueItem>> {
  try {
    const { supabase, user } = await requireUser();
    return await undoReviewRow(supabase, user.id, reviewId);
  } catch (e) {
    return failed(e);
  }
}

export async function dueTomorrow(deckId: string | null): Promise<number | null> {
  try {
    const { supabase, user } = await requireUser();
    return await dueTomorrowCount(supabase, user.id, deckId);
  } catch {
    return null;
  }
}

export async function updateCard(cardId: string, patch: { suspended?: boolean; flagged?: boolean; bury?: boolean }): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await patchCardRow(supabase, user.id, cardId, patch);
    if (!r.ok) return r;
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/* --------------------------------------------------------------- settings */

export async function saveSettings(s: Settings): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await saveSettingsRow(supabase, user.id, s);
    if (!r.ok) return r;
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/* ----------------------------------------------------------------- import */

export async function importNotes(
  rows: ImportRow[],
  opts: { deckId: string; kind: NoteKind; duplicates: "skip" | "update" | "create"; tags?: string },
): Promise<Value<ImportReport>> {
  try {
    const { supabase, user } = await requireUser();
    const r = await importNotesRows(supabase, user.id, rows, opts);
    if (r.ok) refresh();
    return r;
  } catch (e) {
    return failed(e);
  }
}

/* ------------------------------------------------------------------ media */

/** Store a pasted image (already resized in the browser); returns its URL. */
export async function uploadImage(form: FormData): Promise<Value<string>> {
  try {
    const { supabase, user } = await requireUser();
    const file = form.get("file");
    if (!(file instanceof Blob)) return { ok: false, error: "No image." };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await saveMedia(supabase, user.id, bytes, file.type);
    if (!r.ok) return r;
    return { ok: true, value: `/flashcards/media/${r.value}` };
  } catch (e) {
    return failed(e);
  }
}
