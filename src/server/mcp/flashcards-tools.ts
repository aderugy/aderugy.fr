import "server-only";
import { z } from "zod";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import { addDaysISO } from "@/lib/agenda/zoned";
import { findDeck } from "@/lib/flashcards/decks";
import { cardOrds, plainText } from "@/lib/flashcards/notes";
import { formatDelay } from "@/lib/flashcards/scheduler";
import { CARD_STATES, KIND_LABELS, LIMITS, NOTE_KINDS, STATE_LABELS, type Card } from "@/lib/flashcards/types";
import { decksWithCounts, loadDecks, loadStats, saveNote, searchNotes } from "@/server/flashcards/data";
import { callerOf } from "./auth";

/**
 * /flashcards as MCP tools, on the same connector as the backlog.
 *
 * Every call goes through server/flashcards/data.ts with the caller's own
 * token, so RLS and the connector rules of migration 0023 apply: Claude may
 * read everything and write notes, which always land in the inbox, without
 * cards, until Arthur accepts them. Decks, scheduling, ratings and deletions
 * stay with him in the app.
 */

export const FLASHCARDS_INSTRUCTIONS = `Arthur's flash cards (aderugy.fr/flashcards): spaced repetition (FSRS) over decks he organises himself.

How the data works:
- A note is what gets written; it generates cards. Kinds: "basic" (front → back), "reversed" (also back → front), "cloze" (the front holds gaps {{c1::answer}} or {{c1::answer::hint}}, one card per number; the back is optional extra), "type_answer" (he types the back, which must be short and exact).
- Fields are Markdown with KaTeX math ($…$ inline, $$…$$ display) and fenced code. Extra is shown under the answer (why, context); source is a URL or a site path such as /maths/n/<id>.
- Decks form a tree, named by path with "::" ("Maths::Lois"). Decks are his: list_decks shows them, and they cannot be created from here — if none fits, say so and suggest one.
- Tags are single words, hierarchical with "::" (poker::mdf).
- Notes you create go to his inbox: nothing is reviewed until he accepts them, and he may edit or reject them. You cannot edit accepted notes, reschedule, rate or delete anything.

Writing good cards: one fact per card, a question that has one answer, the answer short (detail goes in extra); prefer cloze for definitions and theorems, reversed for terms he must recall both ways; French when the material is French. Check search_notes first so as not to duplicate what he has.`;

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function cardsLine(cards: Card[], now: number): string {
  if (cards.length === 0) return "no cards (in the inbox)";
  return cards
    .map((c) => {
      const bits = [STATE_LABELS[c.state].toLowerCase()];
      if (c.state !== "new") {
        const ms = Date.parse(c.due) - now;
        bits.push(ms <= 0 ? "due" : `due in ${formatDelay(ms)}`);
      }
      if (c.lapses) bits.push(`${c.lapses} lapses`);
      if (c.suspended) bits.push("suspended");
      return bits.join(" ");
    })
    .join("; ");
}

const deckRef = z.string().max(400).describe('A deck path ("Maths::Lois", any case) or id, from list_decks.');

export function registerFlashcardsTools(server: McpServer) {
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
      const { decks, total } = await decksWithCounts(db, userId);
      if (decks.length === 0) return ok("No deck yet. Arthur creates decks in the app.");
      const lines = decks.map(
        (d) =>
          `${"  ".repeat(d.depth)}- ${d.path} — ${d.counts.cards} cards · today ${d.counts.newCards} new, ${d.counts.learningDue} learning, ${d.counts.reviewDue} due (id ${d.id})`,
      );
      return ok(`Today in all decks: ${total.newCards} new, ${total.learningDue} learning, ${total.reviewDue} due.\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search flash card notes",
      description: "Find notes by text (front, back, extra), deck, tag, kind or card state. Returns each note's fields and its cards' state. Use it before creating notes, to avoid duplicates.",
      inputSchema: z.object({
        query: z.string().max(200).optional().describe("Words that must all appear."),
        deck: deckRef.optional().describe("Limit to this deck and its sub-decks."),
        tag: z.string().max(60).optional().describe("A tag; its children match too."),
        kind: z.enum(NOTE_KINDS).optional(),
        state: z.enum([...CARD_STATES, "suspended", "flagged", "leech"]).optional().describe("Notes with at least one card in this state."),
        limit: z.number().int().min(1).max(50).optional().describe("Default 20."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      let deckId: string | undefined;
      if (input.deck) {
        const decks = await loadDecks(db, userId);
        const d = findDeck(decks, input.deck);
        if (!d) return failure(`No deck "${input.deck}". Call list_decks.`);
        deckId = d.id;
      }
      const limit = input.limit ?? 20;
      const { notes, more } = await searchNotes(db, userId, { q: input.query, deckId, tag: input.tag, kind: input.kind, state: input.state }, 0, limit);
      if (notes.length === 0) return ok("No note matches.");
      const now = Date.now();
      const body = notes.map((n) =>
        [
          `### ${clip(plainText(n.front), 120)} (note ${n.id})`,
          `${n.deck_path} · ${KIND_LABELS[n.kind]}${n.tags.length ? ` · tags ${n.tags.join(" ")}` : ""}${n.created_by === "claude" ? " · written by Claude" : ""}`,
          `Front: ${clip(n.front, 600)}`,
          n.back ? `Back: ${clip(n.back, 600)}` : "",
          n.extra ? `Extra: ${clip(n.extra, 400)}` : "",
          `Cards: ${cardsLine(n.cards, now)}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return ok(`${notes.length}${more ? "+" : ""} note${notes.length > 1 ? "s" : ""}:\n\n${body.join("\n\n")}`);
    },
  );

  server.registerTool(
    "create_notes",
    {
      title: "Write flash card notes",
      description:
        `Write up to ${LIMITS.batch} notes. They go to Arthur's inbox, where he accepts, edits or rejects them; only accepted notes are reviewed. Each note names an existing deck. Notes that fail validation are reported and the others are still created.`,
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
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ notes }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const decks = await loadDecks(db, userId);
      const lines: string[] = [];
      let created = 0;
      for (const [i, n] of notes.entries()) {
        const deck = findDeck(decks, n.deck);
        if (!deck) {
          lines.push(`${i + 1}. not created: no deck "${n.deck}" (decks: ${decks.length ? "see list_decks" : "none yet"})`);
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
        });
        if (!r.ok) {
          lines.push(`${i + 1}. not created: ${r.error}`);
          continue;
        }
        created++;
        const cards = cardOrds({ kind, front: n.front, back: n.back ?? "" }).length;
        lines.push(
          `${i + 1}. created in ${n.deck} — ${cards} card${cards === 1 ? "" : "s"} once accepted${r.value.duplicateOf ? ` · a note with the same front exists (note ${r.value.duplicateOf})` : ""} (note ${r.value.id})`,
        );
      }
      const head = created
        ? `${created} of ${notes.length} note${notes.length > 1 ? "s" : ""} waiting in Arthur's inbox (aderugy.fr/flashcards/inbox).`
        : "No note was created.";
      return created ? ok(`${head}\n${lines.join("\n")}`) : failure(`${head}\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "get_flashcard_stats",
    {
      title: "Flash card statistics",
      description: "How Arthur's reviewing is going: streak, ratings and time over 7 and 30 days, retention against his target, what is due over the next 7 days, cards by state.",
      inputSchema: z.object({ deck: deckRef.optional().describe("Limit to this deck and its sub-decks.") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ deck }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      let deckId: string | null = null;
      if (deck) {
        const d = findDeck(await loadDecks(db, userId), deck);
        if (!d) return failure(`No deck "${deck}". Call list_decks.`);
        deckId = d.id;
      }
      const s = await loadStats(db, userId, { deckId });
      const since = (n: number) => s.days.filter((d) => d.day >= addDaysISO(s.today, -(n - 1)));
      const sum = (rows: typeof s.days, f: (d: (typeof s.days)[number]) => number) => rows.reduce((a, d) => a + f(d), 0);
      const w = since(7);
      const m = since(30);
      const pass = sum(m, (d) => d.pass);
      const total = sum(m, (d) => d.total);
      const next7 = Array.from({ length: 7 }, (_, i) => addDaysISO(s.today, i)).map((day) => `${day}: ${s.forecast.find((f) => f.day === day)?.cards ?? 0}`);
      return ok(
        [
          `# Flash cards${s.deckName ? ` — ${s.deckName}` : ""} (review day ${s.today})`,
          `Streak: ${s.streak} day${s.streak === 1 ? "" : "s"}.`,
          `Last 7 days: ${sum(w, (d) => d.reviews)} ratings, ${sum(w, (d) => d.newCards)} new cards, ${Math.round(sum(w, (d) => d.ms) / 60_000)} min, active on ${w.filter((d) => d.reviews + d.cram > 0).length} days.`,
          `Last 30 days: ${sum(m, (d) => d.reviews)} ratings, ${Math.round(sum(m, (d) => d.ms) / 60_000)} min.`,
          `Retention (30 days, first rating of the day of cards in review): ${total ? `${Math.round((pass / total) * 100)}% (${pass}/${total})` : "no sample yet"}; target ${Math.round(s.settings.retention * 100)}%.`,
          `Due, next 7 days (today includes overdue): ${next7.join(", ")}.`,
          `Cards: ${s.states.new} new, ${s.states.learning} learning, ${s.states.review} review, ${s.states.relearning} relearning, ${s.states.suspended} suspended.`,
          `Daily limits: ${s.settings.newPerDay} new, ${s.settings.reviewsPerDay} reviews.`,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "list_hard_cards",
    {
      title: "List the hardest flash cards",
      description: "Cards Arthur keeps failing (most lapses, then highest FSRS difficulty), leeches included, with their full content — to suggest a rewrite or a split, written as new notes with create_notes.",
      inputSchema: z.object({
        deck: deckRef.optional(),
        limit: z.number().int().min(1).max(20).optional().describe("Default 10."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ deck, limit }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      let deckId: string | null = null;
      if (deck) {
        const d = findDeck(await loadDecks(db, userId), deck);
        if (!d) return failure(`No deck "${deck}". Call list_decks.`);
        deckId = d.id;
      }
      const s = await loadStats(db, userId, { deckId });
      const rows = s.hardest.filter((h) => h.card.lapses > 0 || h.card.difficulty >= 7).slice(0, limit ?? 10);
      if (rows.length === 0) return ok("No card is giving trouble yet.");
      return ok(
        rows
          .map((h) =>
            [
              `### ${clip(plainText(h.note.front), 120)} (note ${h.note.id})`,
              `${h.deckPath} · ${KIND_LABELS[h.note.kind]} · ${h.card.lapses} lapses in ${h.card.reps} ratings · difficulty ${h.card.difficulty.toFixed(1)}/10${h.card.suspended ? " · suspended" : ""}${h.note.tags.includes("leech") ? " · leech" : ""}`,
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
