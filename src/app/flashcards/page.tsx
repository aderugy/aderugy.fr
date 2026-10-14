import { requireUser } from "@/server/auth";
import { decksWithCounts, loadInbox } from "@/server/flashcards/data";
import { DeckList } from "@/components/flashcards/DeckList";

export const metadata = { title: "Decks — Flashcards" };

export default async function FlashcardsPage() {
  const { supabase, user } = await requireUser();

  let loaded;
  try {
    const [{ decks, total, doneToday }, inbox] = await Promise.all([decksWithCounts(supabase, user.id), loadInbox(supabase, user.id)]);
    loaded = { decks, total, doneToday, inbox: inbox.length };
  } catch (e) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
        <h1 className="font-medium">Could not load your decks</h1>
        <p className="mt-2 text-muted">{(e as { message?: string })?.message ?? String(e)}</p>
        <p className="mt-4 text-muted">
          If this is the first visit, apply <code>supabase/migrations/0023_flashcards.sql</code> first.
        </p>
      </main>
    );
  }

  return <DeckList decks={loaded.decks} total={loaded.total} doneToday={loaded.doneToday} inbox={loaded.inbox} />;
}
