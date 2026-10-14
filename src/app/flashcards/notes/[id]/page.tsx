import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { cardHistory, getNote, loadDecks, loadSettings } from "@/server/flashcards/data";
import { deckTree, flatten } from "@/lib/flashcards/decks";
import { NoteEditor } from "@/components/flashcards/NoteEditor";
import { NoteCards } from "@/components/flashcards/NoteCards";

export const metadata = { title: "Note — Flashcards" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NotePage({ params }: PageProps<"/flashcards/notes/[id]">) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { supabase, user } = await requireUser();
  const [note, decks, settings] = await Promise.all([getNote(supabase, user.id, id), loadDecks(supabase, user.id), loadSettings(supabase, user.id)]);
  if (!note) notFound();
  const history = await cardHistory(supabase, user.id, note.cards.map((c) => c.id));
  const deckList = flatten(deckTree(decks)).map((d) => ({ id: d.id, path: d.path, depth: d.depth }));

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Note</h1>
        <span className="text-xs text-muted">
          {note.deck_path} · {note.created_by === "claude" ? "written by Claude · " : ""}created {note.created_at.slice(0, 10)}
        </span>
        <Link href={`/flashcards/browse?deck=${note.deck_id}`} className="ml-auto text-xs text-muted hover:text-foreground">
          ← Deck notes
        </Link>
      </div>
      {note.inbox && (
        <p className="mb-4 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-xs">
          Waiting in the <Link href="/flashcards/inbox" className="text-accent underline">inbox</Link>: it has no cards until you accept it.
        </p>
      )}
      {note.deleted_at && (
        <p className="mb-4 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs">
          In the trash since {note.deleted_at.slice(0, 10)}; deleted for good 30 days later. Restore it below.
        </p>
      )}
      <NoteEditor
        decks={deckList}
        note={{
          id: note.id,
          deck_id: note.deck_id,
          kind: note.kind,
          front: note.front,
          back: note.back,
          extra: note.extra,
          source: note.source,
          tags: note.tags,
        }}
        cards={note.cards.map((c) => ({ ord: c.ord, reps: c.reps }))}
      />
      <NoteCards noteId={note.id} kind={note.kind} cards={note.cards} history={history} trashed={Boolean(note.deleted_at)} timeZone={settings.timeZone} now={new Date().toISOString()} />
    </main>
  );
}
