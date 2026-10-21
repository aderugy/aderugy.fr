import "server-only";
import { z } from "zod";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysISO, fmtWhen } from "@/lib/agenda/zoned";
import { findDeck } from "@/lib/flashcards/decks";
import { cardOrds, plainText } from "@/lib/flashcards/notes";
import { formatDelay } from "@/lib/flashcards/scheduler";
import {
  CARD_STATES,
  KIND_LABELS,
  LIMITS,
  NOTE_KINDS,
  RATING_LABELS,
  STATE_LABELS,
  type Card,
  type Deck,
  type NoteKind,
} from "@/lib/flashcards/types";
import {
  acceptNotes,
  cardHistory,
  cardsLostBy,
  decksWithCounts,
  deleteDeck,
  deleteNotesForever,
  ensureDeckPath,
  getNote,
  loadDecks,
  loadSettings,
  loadStats,
  loadTags,
  moveNotes,
  patchCard,
  patchDeck,
  rejectNotes,
  renameTag,
  retagNotes,
  saveNote,
  saveSettings,
  searchNotes,
  trashNotes,
} from "@/server/flashcards/data";
import { callerOf } from "./auth";

/**
 * /flashcards as MCP tools, on the same connector as the backlog: full CRUD
 * on decks, notes, cards, tags and settings (migration 0025).
 *
 * Every call goes through server/flashcards/data.ts with the caller's own
 * token, so RLS and the connector rules apply. What stays Arthur's, enforced
 * in the database: rating cards and undoing ratings (the review journal is
 * read-only here) and pasted images.
 */

export const FLASHCARDS_INSTRUCTIONS = `Arthur's flash cards (aderugy.fr/flashcards): spaced repetition (FSRS) over decks he organises. You may create, read, update and delete decks, notes, cards, tags and settings; you cannot rate cards or touch the review history — reviewing is his.

How the data works:
- A note is what gets written; it generates cards. Kinds: "basic" (front → back), "reversed" (also back → front), "cloze" (the front holds gaps {{c1::answer}} or {{c1::answer::hint}}, one card per number; the back is optional extra), "type_answer" (he types the back, which must be short and exact).
- Fields are Markdown with KaTeX math ($…$ inline, $$…$$ display) and fenced code. Extra is shown under the answer (why, context); source is a URL or a site path such as /maths/n/<id>.
- Decks form a tree, named by path with "::" ("Maths::Lois"). Tags are single words, hierarchical with "::" (poker::mdf).
- New notes go to his inbox by default (no cards until accepted); pass to_inbox: false when he asked for the cards to go straight into a deck. Notes you write stay marked as yours.
- Deleting a note moves it to the trash (30 days, restorable); permanent: true deletes it with its cards and their history. Editing a note's text keeps its cards' history; changing its kind or removing cloze gaps deletes cards, which needs allow_card_loss.
- Cards: suspend, flag, bury until tomorrow, reset to new (forgets the schedule), or set the day a card is next due.

Writing good cards: one fact per card, a question with one answer, the answer short (detail goes in extra); prefer cloze for definitions and theorems, reversed for terms he must recall both ways; French when the material is French. Search first so as not to duplicate what he has. Ask before destructive changes he did not request (deleting decks or notes for good, resetting cards).`;

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function cardLabel(kind: NoteKind, ord: number): string {
  if (kind === "cloze") return `c${ord}`;
  if (kind === "reversed") return ord === 1 ? "back→front" : "front→back";
  return "card";
}

function cardLine(kind: NoteKind, c: Card, now: number): string {
  const bits = [STATE_LABELS[c.state].toLowerCase()];
  if (c.state !== "new") {
    const ms = Date.parse(c.due) - now;
    bits.push(ms <= 0 ? "due" : `due in ${formatDelay(ms)}`);
    bits.push(`stability ${c.stability.toFixed(1)} d`, `difficulty ${c.difficulty.toFixed(1)}`);
  }
  if (c.reps) bits.push(`${c.reps} ratings`, `${c.lapses} lapses`);
  if (c.suspended) bits.push("suspended");
  if (c.flagged) bits.push("flagged");
  if (c.buried_until) bits.push(`buried (${c.buried_until})`);
  return `${cardLabel(kind, c.ord)}: ${bits.join(", ")} (card ${c.id})`;
}

const deckRef = z.string().max(400).describe('A deck path ("Maths::Lois", any case) or id, from list_decks.');
const noteIds = z.array(z.string().uuid()).min(1).max(200).describe("Note ids, from search_notes.");

type Resolved = { ok: true; deck: Deck } | { ok: false; error: string };
function resolveDeck(decks: Deck[], ref: string): Resolved {
  const d = findDeck(decks, ref);
  return d ? { ok: true, deck: d } : { ok: false, error: `No deck "${ref}". Call list_decks.` };
}

async function deckIdOf(db: SupabaseClient, userId: string, ref: string | undefined): Promise<{ ok: true; id: string | null } | { ok: false; error: string }> {
  if (!ref) return { ok: true, id: null };
  const r = resolveDeck(await loadDecks(db, userId), ref);
  return r.ok ? { ok: true, id: r.deck.id } : r;
}

export function registerFlashcardsTools(server: McpServer) {
  /* ------------------------------------------------------------- decks */

  server.registerTool(
    "list_decks",
    {
      title: "List flash card decks",
      description: "Arthur's decks as a tree (paths joined with ::), with how many cards each holds and what is due today (new, learning, due), sub-decks included.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const { decks, total, beyond } = await decksWithCounts(db, userId);
      if (decks.length === 0) return ok("No deck yet. Create one with create_deck.");
      const lines = decks.map(
        (d) =>
          `${"  ".repeat(d.depth)}- ${d.path} — ${d.counts.cards} cards · today ${d.counts.newCards} new, ${d.counts.learningDue} learning, ${d.counts.reviewDue} due${d.beyond ? ` (+${d.beyond} past the limits)` : ""} (id ${d.id})`,
      );
      const past = beyond.newCards + beyond.reviewDue;
      const extra = past
        ? ` Past the daily limits (soft: Arthur can still study them): ${beyond.newCards} new, ${beyond.reviewDue} due.`
        : "";
      return ok(`Today in all decks: ${total.newCards} new, ${total.learningDue} learning, ${total.reviewDue} due.${extra}\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "create_deck",
    {
      title: "Create a deck",
      description: 'Create a deck by its path ("Poker::Preflop"); missing parent decks are created too. If the deck already exists, nothing changes.',
      inputSchema: z.object({ path: z.string().min(1).max(400).describe('Deck path, names joined with "::".') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const decks = await loadDecks(db, userId);
      const before = new Set(decks.map((d) => d.id));
      const r = await ensureDeckPath(db, userId, path, decks);
      if (!r.ok) return failure(r.error);
      const created = decks.filter((d) => !before.has(d.id)).length;
      return ok(created ? `Created ${plural(created, "deck")}; "${path}" is deck ${r.value.id}.` : `"${path}" already exists (deck ${r.value.id}).`);
    },
  );

  server.registerTool(
    "update_deck",
    {
      title: "Rename or move a deck",
      description: "Rename a deck, move it under another deck (or to the top level with an empty parent), or change its position among its siblings.",
      inputSchema: z.object({
        deck: deckRef,
        name: z.string().min(1).max(LIMITS.deckName).optional().describe('New name (no "::").'),
        parent: z.string().max(400).optional().describe('New parent deck, path or id; "" for the top level.'),
        position: z.number().int().min(0).max(9999).optional().describe("Order among siblings, lowest first."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ deck, name, parent, position }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const decks = await loadDecks(db, userId);
      const d = resolveDeck(decks, deck);
      if (!d.ok) return failure(d.error);
      let parentId: string | null | undefined;
      if (parent !== undefined) {
        if (parent.trim() === "") parentId = null;
        else {
          const p = resolveDeck(decks, parent);
          if (!p.ok) return failure(p.error);
          parentId = p.deck.id;
        }
      }
      const r = await patchDeck(db, userId, d.deck.id, { name, parentId, position });
      if (!r.ok) return failure(r.error);
      return ok(`Deck ${d.deck.id} updated.`);
    },
  );

  server.registerTool(
    "delete_deck",
    {
      title: "Delete a deck",
      description: "Delete a deck. Its sub-decks move up one level. A deck that holds notes (trash included) needs move_notes_to: its notes go there, with their cards and history.",
      inputSchema: z.object({
        deck: deckRef,
        move_notes_to: deckRef.optional().describe("Deck that receives the notes."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ deck, move_notes_to }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const decks = await loadDecks(db, userId);
      const d = resolveDeck(decks, deck);
      if (!d.ok) return failure(d.error);
      let to: string | null = null;
      if (move_notes_to) {
        const t = resolveDeck(decks, move_notes_to);
        if (!t.ok) return failure(t.error);
        to = t.deck.id;
      }
      const r = await deleteDeck(db, d.deck.id, to);
      if (!r.ok) return failure(r.error);
      return ok(`Deleted deck "${d.deck.name}".`);
    },
  );

  /* ------------------------------------------------------------- notes */

  server.registerTool(
    "search_notes",
    {
      title: "Search flash card notes",
      description:
        "Find notes by text (front, back, extra), deck, tag, kind or card state; or list the inbox or the trash. Returns each note's fields and its cards with their ids. Use it before creating notes, to avoid duplicates.",
      inputSchema: z.object({
        query: z.string().max(200).optional().describe("Words that must all appear."),
        deck: deckRef.optional().describe("Limit to this deck and its sub-decks."),
        tag: z.string().max(60).optional().describe("A tag; its children match too."),
        kind: z.enum(NOTE_KINDS).optional(),
        state: z.enum([...CARD_STATES, "suspended", "flagged", "leech"]).optional().describe("Notes with at least one card in this state."),
        in_inbox: z.boolean().optional().describe("List notes waiting in the inbox instead of accepted ones."),
        in_trash: z.boolean().optional().describe("List notes in the trash."),
        page: z.number().int().min(0).max(1000).optional().describe("0-based page of results."),
        limit: z.number().int().min(1).max(50).optional().describe("Default 20."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const deck = await deckIdOf(db, userId, input.deck);
      if (!deck.ok) return failure(deck.error);
      const limit = input.limit ?? 20;
      const { notes, more } = await searchNotes(
        db,
        userId,
        { q: input.query, deckId: deck.id ?? undefined, tag: input.tag, kind: input.kind, state: input.state, inbox: input.in_inbox, trash: input.in_trash },
        input.page ?? 0,
        limit,
      );
      if (notes.length === 0) return ok("No note matches.");
      const now = Date.now();
      const body = notes.map((n) =>
        [
          `### ${clip(plainText(n.front), 120)} (note ${n.id})`,
          `${n.deck_path} · ${n.kind}${n.tags.length ? ` · tags ${n.tags.join(" ")}` : ""}${n.created_by === "claude" ? " · written by Claude" : ""}${n.inbox ? " · in the inbox" : ""}${n.deleted_at ? ` · in the trash since ${n.deleted_at.slice(0, 10)}` : ""}`,
          `Front: ${clip(n.front, 600)}`,
          n.back ? `Back: ${clip(n.back, 600)}` : "",
          n.extra ? `Extra: ${clip(n.extra, 400)}` : "",
          n.source ? `Source: ${n.source}` : "",
          n.cards.length ? n.cards.map((c) => `- ${cardLine(n.kind, c, now)}`).join("\n") : "- no cards",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return ok(`${notes.length} note${notes.length > 1 ? "s" : ""}${more ? ` (more on page ${(input.page ?? 0) + 1})` : ""}:\n\n${body.join("\n\n")}`);
    },
  );

  server.registerTool(
    "get_note",
    {
      title: "Read one flash card note",
      description: "One note in full: every field, its cards with their schedule, and each card's rating history.",
      inputSchema: z.object({ id: z.string().uuid().describe("Note id.") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const [note, settings] = await Promise.all([getNote(db, userId, id), loadSettings(db, userId)]);
      if (!note) return failure(`No note with id ${id}.`);
      const history = await cardHistory(db, userId, note.cards.map((c) => c.id));
      const now = Date.now();
      const lines = [
        `# Note ${note.id}`,
        `Deck ${note.deck_path} (${note.deck_id}) · ${note.kind} (${KIND_LABELS[note.kind]}) · written by ${note.created_by === "claude" ? "Claude" : "Arthur"} · created ${note.created_at.slice(0, 10)}, edited ${note.updated_at.slice(0, 10)}`,
        note.inbox ? "Waiting in the inbox: no cards until accepted." : "",
        note.deleted_at ? `In the trash since ${note.deleted_at.slice(0, 10)}.` : "",
        `Tags: ${note.tags.join(" ") || "none"}`,
        `Source: ${note.source ?? "none"}`,
        "",
        "## Front",
        note.front,
        "",
        "## Back",
        note.back || "_(empty)_",
        "",
        "## Extra",
        note.extra ?? "_(empty)_",
        "",
        "## Cards",
        note.cards.length ? note.cards.map((c) => `- ${cardLine(note.kind, c, now)}`).join("\n") : "_(none)_",
      ];
      if (history.length) {
        lines.push("", "## Ratings, newest first");
        for (const h of history.slice(0, 60)) {
          const c = note.cards.find((x) => x.id === h.card_id);
          lines.push(
            `- ${fmtWhen(h.reviewed_at, settings.timeZone)} · ${c ? cardLabel(note.kind, c.ord) : "?"} · ${RATING_LABELS[h.rating]}${h.kind === "cram" ? " (cram)" : ""} · ${h.state_before} → ${h.state_after} · ${Math.round(h.duration_ms / 1000)} s`,
          );
        }
      }
      return ok(lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n"));
    },
  );

  server.registerTool(
    "create_notes",
    {
      title: "Write flash card notes",
      description: `Write up to ${LIMITS.batch} notes. By default they wait in Arthur's inbox, where he accepts, edits or rejects them; with to_inbox: false their cards go straight into the deck. Notes that fail validation are reported and the others are still created.`,
      inputSchema: z.object({
        notes: z
          .array(
            z.object({
              deck: deckRef,
              kind: z.enum(NOTE_KINDS).optional().describe('Default "basic".'),
              front: z.string().min(1).max(LIMITS.field).describe("Markdown. For cloze: the text with {{c1::…}} gaps."),
              back: z.string().max(LIMITS.field).optional().describe("Markdown. Required except for cloze."),
              extra: z.string().max(LIMITS.field).optional().describe("Shown under the answer: why, context."),
              tags: z.array(z.string().max(LIMITS.tag)).max(LIMITS.tagsPerNote).optional(),
              source: z.string().max(LIMITS.source).optional().describe("A URL or a site path such as /maths/n/<id>."),
            }),
          )
          .min(1)
          .max(LIMITS.batch),
        to_inbox: z.boolean().optional().describe("Default true. False puts the cards straight into their decks."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ notes, to_inbox }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const inbox = to_inbox ?? true;
      const decks = await loadDecks(db, userId);
      const lines: string[] = [];
      let created = 0;
      for (const [i, n] of notes.entries()) {
        const deck = findDeck(decks, n.deck);
        if (!deck) {
          lines.push(`${i + 1}. not created: no deck "${n.deck}" (create it with create_deck)`);
          continue;
        }
        const kind = n.kind ?? "basic";
        const r = await saveNote(db, userId, {
          deckId: deck.id,
          kind,
          front: n.front,
          back: n.back ?? "",
          extra: n.extra ?? null,
          source: n.source ?? null,
          tags: n.tags ?? [],
          inbox,
        });
        if (!r.ok) {
          lines.push(`${i + 1}. not created: ${r.error}`);
          continue;
        }
        created++;
        const cards = cardOrds({ kind, front: n.front, back: n.back ?? "" }).length;
        lines.push(
          `${i + 1}. created in ${n.deck} — ${plural(cards, "card")}${inbox ? " once accepted" : ""}${r.value.duplicateOf ? ` · a note with the same front exists (note ${r.value.duplicateOf})` : ""} (note ${r.value.id})`,
        );
      }
      const head = created
        ? inbox
          ? `${created} of ${notes.length} notes waiting in Arthur's inbox (aderugy.fr/flashcards/inbox).`
          : `${created} of ${notes.length} notes added to their decks.`
        : "No note was created.";
      return created ? ok(`${head}\n${lines.join("\n")}`) : failure(`${head}\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "update_note",
    {
      title: "Edit a flash card note",
      description:
        "Change any field of one note: deck, kind, front, back, extra, source, tags (replaces them). Fields left out stay. Editing text keeps the cards' history; an edit that removes cards that have been reviewed (kind changed, cloze gap removed) is refused unless allow_card_loss is true.",
      inputSchema: z.object({
        id: z.string().uuid().describe("Note id."),
        deck: deckRef.optional(),
        kind: z.enum(NOTE_KINDS).optional(),
        front: z.string().min(1).max(LIMITS.field).optional(),
        back: z.string().max(LIMITS.field).optional(),
        extra: z.string().max(LIMITS.field).optional().describe('"" clears it.'),
        source: z.string().max(LIMITS.source).optional().describe('"" clears it.'),
        tags: z.array(z.string().max(LIMITS.tag)).max(LIMITS.tagsPerNote).optional().describe("The full new list."),
        allow_card_loss: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const note = await getNote(db, userId, input.id);
      if (!note) return failure(`No note with id ${input.id}.`);
      let deckId = note.deck_id;
      if (input.deck) {
        const d = resolveDeck(await loadDecks(db, userId), input.deck);
        if (!d.ok) return failure(d.error);
        deckId = d.deck.id;
      }
      const next = {
        kind: input.kind ?? note.kind,
        front: input.front ?? note.front,
        back: input.back ?? note.back,
        extra: input.extra !== undefined ? input.extra || null : note.extra,
        source: input.source !== undefined ? input.source || null : note.source,
        tags: input.tags ?? note.tags,
      };
      const lost = cardsLostBy(note, next);
      if (lost.length && !input.allow_card_loss) {
        return failure(
          `Nothing changed: this edit would delete ${plural(lost.length, "reviewed card")} (${lost.map((o) => cardLabel(note.kind, o)).join(", ")}) and their history. Pass allow_card_loss: true to go ahead.`,
        );
      }
      const r = await saveNote(db, userId, { id: note.id, deckId, ...next });
      if (!r.ok) return failure(`Nothing changed: ${r.error}`);
      const bits = [`Note ${note.id} saved.`];
      if (r.value.removedCards) bits.push(`${plural(r.value.removedCards, "card")} removed.`);
      if (r.value.duplicateOf) bits.push(`A note with the same front exists in that deck (note ${r.value.duplicateOf}).`);
      return ok(bits.join(" "));
    },
  );

  server.registerTool(
    "delete_notes",
    {
      title: "Delete flash card notes",
      description: "Move notes to the trash (restorable for 30 days), or with permanent: true delete them now with their cards and rating history.",
      inputSchema: z.object({ ids: noteIds, permanent: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids, permanent }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const t = await trashNotes(db, userId, ids, true);
      if (!t.ok) return failure(t.error);
      if (!permanent) return ok(`${plural(t.value, "note")} moved to the trash (restore_notes brings them back).`);
      const d = await deleteNotesForever(db, userId, ids);
      if (!d.ok) return failure(d.error);
      return ok(`${plural(d.value, "note")} deleted for good, with their cards and history.`);
    },
  );

  server.registerTool(
    "restore_notes",
    {
      title: "Restore notes from the trash",
      description: "Take notes out of the trash, with their cards and history as they were.",
      inputSchema: z.object({ ids: noteIds }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const r = await trashNotes(db, userId, ids, false);
      return r.ok ? ok(`${plural(r.value, "note")} restored.`) : failure(r.error);
    },
  );

  server.registerTool(
    "move_notes",
    {
      title: "Move notes to another deck",
      description: "Move notes, with their cards and history, to another deck.",
      inputSchema: z.object({ ids: noteIds, deck: deckRef }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids, deck }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const d = resolveDeck(await loadDecks(db, userId), deck);
      if (!d.ok) return failure(d.error);
      const r = await moveNotes(db, userId, ids, d.deck.id);
      return r.ok ? ok(`${plural(r.value, "note")} moved to ${deck}.`) : failure(r.error);
    },
  );

  server.registerTool(
    "tag_notes",
    {
      title: "Add or remove tags on notes",
      description: "Add tags to and/or remove tags from many notes at once. Other tags stay.",
      inputSchema: z.object({
        ids: noteIds,
        add: z.array(z.string().max(LIMITS.tag)).max(20).optional(),
        remove: z.array(z.string().max(LIMITS.tag)).max(20).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids, add, remove }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      if (!add?.length && !remove?.length) return failure("Give tags to add or to remove.");
      const r = await retagNotes(db, userId, ids, add ?? [], remove ?? []);
      return r.ok ? ok(`${plural(r.value, "note")} changed.`) : failure(r.error);
    },
  );

  server.registerTool(
    "review_inbox",
    {
      title: "Accept or reject inbox notes",
      description: "Accept notes waiting in the inbox (their cards are created and enter reviews) or reject them (deleted). List them with search_notes in_inbox: true.",
      inputSchema: z.object({ ids: noteIds, action: z.enum(["accept", "reject"]) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids, action }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const r = action === "accept" ? await acceptNotes(db, userId, ids) : await rejectNotes(db, userId, ids);
      if (!r.ok) return failure(r.error);
      const skipped = ids.length - r.value;
      return ok(`${plural(r.value, "note")} ${action === "accept" ? "accepted" : "rejected"}${skipped ? ` (${skipped} not in the inbox, left alone)` : ""}.`);
    },
  );

  /* ------------------------------------------------------------- cards */

  server.registerTool(
    "update_cards",
    {
      title: "Suspend, flag, bury, reset or reschedule cards",
      description:
        "Change cards, picked by card id or by note (all of a note's cards). suspended and flagged set those switches; bury hides until the next review day; reset sends a card back to new (its schedule is forgotten, its history kept); due_date sets the review day a card comes back (not for new cards).",
      inputSchema: z.object({
        card_ids: z.array(z.string().uuid()).max(200).optional(),
        note_ids: z.array(z.string().uuid()).max(200).optional(),
        suspended: z.boolean().optional(),
        flagged: z.boolean().optional(),
        bury: z.boolean().optional(),
        reset: z.boolean().optional(),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const ids = new Set(input.card_ids ?? []);
      if (input.note_ids?.length) {
        const { data, error } = await db.from("fc_cards").select("id").eq("user_id", userId).in("note_id", input.note_ids);
        if (error) throw new Error(error.message);
        for (const c of data ?? []) ids.add(c.id as string);
      }
      if (ids.size === 0) return failure("No card picked: give card_ids or note_ids of notes that have cards.");
      const patch = { suspended: input.suspended, flagged: input.flagged, bury: input.bury, reset: input.reset || undefined, dueDay: input.due_date };
      if (Object.values(patch).every((v) => v === undefined)) return failure("Nothing to change.");
      const errors: string[] = [];
      let done = 0;
      for (const id of ids) {
        const r = await patchCard(db, userId, id, patch);
        if (r.ok) done++;
        else errors.push(`card ${id}: ${r.error}`);
      }
      const head = `${plural(done, "card")} updated.`;
      return errors.length ? (done ? ok(`${head}\n${errors.join("\n")}`) : failure(errors.join("\n"))) : ok(head);
    },
  );

  /* -------------------------------------------------------------- tags */

  server.registerTool(
    "list_tags",
    {
      title: "List flash card tags",
      description: "Every tag in use, with how many notes carry it.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_input, ctx) => {
      const { db } = callerOf(ctx.http?.authInfo);
      const tags = await loadTags(db);
      return ok(tags.length ? tags.map((t) => `- ${t.tag} (${t.notes})`).join("\n") : "No tag yet.");
    },
  );

  server.registerTool(
    "rename_tag",
    {
      title: "Rename or merge a tag",
      description: "Rename a tag on every note, its children too (poker → cash turns poker::mdf into cash::mdf). Renaming onto an existing tag merges them.",
      inputSchema: z.object({ from: z.string().min(1).max(LIMITS.tag), to: z.string().min(1).max(LIMITS.tag) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ from, to }, ctx) => {
      const { db } = callerOf(ctx.http?.authInfo);
      const r = await renameTag(db, from, to);
      return r.ok ? ok(`Renamed on ${plural(r.value, "note")}.`) : failure(r.error);
    },
  );

  /* ------------------------------------------------------ stats, settings */

  server.registerTool(
    "get_flashcard_stats",
    {
      title: "Flash card statistics and settings",
      description: "How Arthur's reviewing is going: streak, ratings and time over 7 and 30 days, retention against his target, what is due over the next 7 days, cards by state; and his scheduling settings.",
      inputSchema: z.object({ deck: deckRef.optional().describe("Limit to this deck and its sub-decks.") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ deck }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const d = await deckIdOf(db, userId, deck);
      if (!d.ok) return failure(d.error);
      const s = await loadStats(db, userId, { deckId: d.id });
      const since = (n: number) => s.days.filter((x) => x.day >= addDaysISO(s.today, -(n - 1)));
      const sum = (rows: typeof s.days, f: (x: (typeof s.days)[number]) => number) => rows.reduce((a, x) => a + f(x), 0);
      const w = since(7);
      const m = since(30);
      const pass = sum(m, (x) => x.pass);
      const total = sum(m, (x) => x.total);
      const next7 = Array.from({ length: 7 }, (_, i) => addDaysISO(s.today, i)).map((day) => `${day}: ${s.forecast.find((f) => f.day === day)?.cards ?? 0}`);
      const st = s.settings;
      return ok(
        [
          `# Flash cards${s.deckName ? ` — ${s.deckName}` : ""} (review day ${s.today})`,
          `Streak: ${plural(s.streak, "day")}.`,
          `Last 7 days: ${sum(w, (x) => x.reviews)} ratings, ${sum(w, (x) => x.newCards)} new cards, ${Math.round(sum(w, (x) => x.ms) / 60_000)} min, active on ${w.filter((x) => x.reviews + x.cram > 0).length} days.`,
          `Last 30 days: ${sum(m, (x) => x.reviews)} ratings, ${Math.round(sum(m, (x) => x.ms) / 60_000)} min.`,
          `Retention (30 days, first rating of the day of cards in review): ${total ? `${Math.round((pass / total) * 100)}% (${pass}/${total})` : "no sample yet"}; target ${Math.round(st.retention * 100)}%.`,
          `Due, next 7 days (today includes overdue): ${next7.join(", ")}.`,
          `Cards: ${s.states.new} new, ${s.states.learning} learning, ${s.states.review} review, ${s.states.relearning} relearning, ${s.states.suspended} suspended.`,
          "",
          "## Settings",
          `retention ${st.retention} · new_per_day ${st.newPerDay} · reviews_per_day ${st.reviewsPerDay} · learning_steps ${st.learningSteps.join(" ")} min · relearning_steps ${st.relearningSteps.join(" ") || "none"} · day_starts_hour ${st.dayStartsHour} · time_zone ${st.timeZone} · leech_threshold ${st.leechThreshold} · swipe_gestures ${st.swipeGestures}`,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "update_flashcard_settings",
    {
      title: "Change flash card settings",
      description: "Change Arthur's scheduling settings. Fields left out stay as they are.",
      inputSchema: z.object({
        retention: z.number().min(0.7).max(0.97).optional().describe("Target probability of recall, 0.70–0.97."),
        new_per_day: z.number().int().min(0).max(9999).optional(),
        reviews_per_day: z.number().int().min(0).max(99999).optional(),
        learning_steps: z.array(z.number().int().min(1).max(1440)).min(1).max(8).optional().describe("Minutes."),
        relearning_steps: z.array(z.number().int().min(1).max(1440)).max(8).optional().describe("Minutes; may be empty."),
        day_starts_hour: z.number().int().min(0).max(23).optional(),
        time_zone: z.string().max(64).optional().describe("IANA zone, e.g. Europe/Paris."),
        leech_threshold: z.number().int().min(2).max(99).optional(),
        swipe_gestures: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const cur = await loadSettings(db, userId);
      const r = await saveSettings(db, userId, {
        retention: input.retention ?? cur.retention,
        newPerDay: input.new_per_day ?? cur.newPerDay,
        reviewsPerDay: input.reviews_per_day ?? cur.reviewsPerDay,
        learningSteps: input.learning_steps ?? cur.learningSteps,
        relearningSteps: input.relearning_steps ?? cur.relearningSteps,
        dayStartsHour: input.day_starts_hour ?? cur.dayStartsHour,
        timeZone: input.time_zone ?? cur.timeZone,
        leechThreshold: input.leech_threshold ?? cur.leechThreshold,
        swipeGestures: input.swipe_gestures ?? cur.swipeGestures,
      });
      return r.ok ? ok("Settings saved.") : failure(r.error);
    },
  );

  server.registerTool(
    "list_hard_cards",
    {
      title: "List the hardest flash cards",
      description: "Cards Arthur keeps failing (most lapses, then highest FSRS difficulty), leeches included, with their full content — to rewrite them with update_note, split them, or reset them.",
      inputSchema: z.object({
        deck: deckRef.optional(),
        limit: z.number().int().min(1).max(20).optional().describe("Default 10."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ deck, limit }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const d = await deckIdOf(db, userId, deck);
      if (!d.ok) return failure(d.error);
      const s = await loadStats(db, userId, { deckId: d.id });
      const rows = s.hardest.filter((h) => h.card.lapses > 0 || h.card.difficulty >= 7).slice(0, limit ?? 10);
      if (rows.length === 0) return ok("No card is giving trouble yet.");
      return ok(
        rows
          .map((h) =>
            [
              `### ${clip(plainText(h.note.front), 120)} (note ${h.note.id}, card ${h.card.id})`,
              `${h.deckPath} · ${h.note.kind} · ${h.card.lapses} lapses in ${h.card.reps} ratings · difficulty ${h.card.difficulty.toFixed(1)}/10${h.card.suspended ? " · suspended" : ""}${h.note.tags.includes("leech") ? " · leech" : ""}`,
              `Front: ${clip(h.note.front, 800)}`,
              h.note.back ? `Back: ${clip(h.note.back, 800)}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          )
          .join("\n\n"),
      );
    },
  );
}
