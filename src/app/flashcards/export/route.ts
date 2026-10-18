import { createClient, userFromClaims } from "@/lib/supabase/server";
import { exportNotes } from "@/server/flashcards/data";
import { toCsvRow } from "@/lib/flashcards/text";

/**
 * Export a deck subtree (`?deck=<id>`) or everything.
 *
 * - `format=csv` (default): one note per line — deck, kind, front, back,
 *   extra, tags, source — which the import reads back.
 * - `format=json`: notes with their cards and the whole review history, the
 *   complete backup.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const deck = url.searchParams.get("deck");
  const format = url.searchParams.get("format") === "json" ? "json" : "csv";
  const supabase = await createClient();
  const user = await userFromClaims(supabase);
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { notes, reviews, paths, decks } = await exportNotes(supabase, user.id, deck || null);
  const stamp = new Date().toISOString().slice(0, 10);
  const base = deck ? (paths.get(deck) ?? "deck").replace(/[^\w-]+/g, "-").toLowerCase() : "all";

  if (format === "json") {
    const body = JSON.stringify(
      {
        exported_at: new Date().toISOString(),
        decks: decks.map((d) => ({ ...d, path: paths.get(d.id) ?? null })),
        notes: notes.map(({ fc_cards, ...n }) => ({ ...n, deck_path: paths.get(n.deck_id) ?? null, cards: fc_cards })),
        reviews,
      },
      null,
      2,
    );
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="flashcards-${base}-${stamp}.json"`,
      },
    });
  }

  const lines = [toCsvRow(["deck", "kind", "front", "back", "extra", "tags", "source"])];
  for (const n of notes) {
    lines.push(toCsvRow([paths.get(n.deck_id) ?? "", n.kind, n.front, n.back, n.extra, n.tags.join(" "), n.source]));
  }
  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="flashcards-${base}-${stamp}.csv"`,
    },
  });
}
