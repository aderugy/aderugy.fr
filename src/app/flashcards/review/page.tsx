import { requireUser } from "@/server/auth";
import { loadCram, loadDecks, loadSession } from "@/server/flashcards/data";
import { deckTree, flatten } from "@/lib/flashcards/decks";
import { Reviewer } from "@/components/flashcards/Reviewer";

export const metadata = { title: "Study — Flashcards" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * A session over a deck subtree (`?deck=`), or every deck. `?cram=1` crams
 * the selection instead (`&tag=` narrows it): every card, nothing rescheduled.
 */
export default async function ReviewPage({ searchParams }: PageProps<"/flashcards/review">) {
  const sp = await searchParams;
  const deck = first(sp.deck);
  const deckId = deck && UUID.test(deck) ? deck : null;
  const cram = first(sp.cram) === "1";
  const tag = first(sp.tag)?.trim() || null;
  const { supabase, user } = await requireUser();
  const [session, decks] = await Promise.all([
    cram ? loadCram(supabase, user.id, { deckId, tag }) : loadSession(supabase, user.id, { deckId }),
    loadDecks(supabase, user.id),
  ]);
  const deckList = flatten(deckTree(decks)).map((d) => ({ id: d.id, path: d.path, depth: d.depth }));

  return (
    <Reviewer
      // A new selection is a new session.
      key={`${deckId ?? "all"}-${cram}-${tag ?? ""}`}
      initial={session.queue}
      settings={session.settings}
      cram={cram}
      deckId={deckId}
      deckName={session.deckName}
      heldBack={session.heldBack}
      decks={deckList}
    />
  );
}
