import Link from "next/link";
import { requireUser } from "@/server/auth";
import { loadDecks } from "@/server/flashcards/data";
import { deckTree, flatten } from "@/lib/flashcards/decks";
import { isNoteKind } from "@/lib/flashcards/types";
import { NoteEditor } from "@/components/flashcards/NoteEditor";

export const metadata = { title: "New note — Flashcards" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function NewNotePage({ searchParams }: PageProps<"/flashcards/notes/new">) {
  const sp = await searchParams;
  const { supabase, user } = await requireUser();
  const decks = flatten(deckTree(await loadDecks(supabase, user.id))).map((d) => ({ id: d.id, path: d.path, depth: d.depth }));
  const deck = first(sp.deck);
  const kind = first(sp.kind);
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="mb-5 flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">New note</h1>
        <Link href={deck ? `/flashcards/browse?deck=${deck}` : "/flashcards/browse"} className="ml-auto text-xs text-muted hover:text-foreground">
          Browse notes →
        </Link>
      </div>
      <NoteEditor
        decks={decks}
        defaults={{
          deckId: decks.some((d) => d.id === deck) ? deck : undefined,
          kind: isNoteKind(kind) ? kind : undefined,
        }}
      />
    </main>
  );
}
