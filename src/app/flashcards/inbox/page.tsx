import { requireUser } from "@/server/auth";
import { loadDecks, loadInbox } from "@/server/flashcards/data";
import { deckPath } from "@/lib/flashcards/decks";
import { Inbox } from "@/components/flashcards/Inbox";

export const metadata = { title: "Inbox — Flashcards" };

export default async function InboxPage() {
  const { supabase, user } = await requireUser();
  const [notes, decks] = await Promise.all([loadInbox(supabase, user.id), loadDecks(supabase, user.id)]);
  return <Inbox notes={notes.map((n) => ({ ...n, deck_path: deckPath(decks, n.deck_id) ?? "?" }))} />;
}
