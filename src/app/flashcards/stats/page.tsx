import { requireUser } from "@/server/auth";
import { loadDecks, loadStats } from "@/server/flashcards/data";
import { deckTree, flatten } from "@/lib/flashcards/decks";
import { StatsView } from "@/components/flashcards/Stats";

export const metadata = { title: "Stats — Flashcards" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function StatsPage({ searchParams }: PageProps<"/flashcards/stats">) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.deck) ? sp.deck[0] : sp.deck;
  const deckId = raw && UUID.test(raw) ? raw : null;
  const { supabase, user } = await requireUser();
  const [stats, decks] = await Promise.all([loadStats(supabase, user.id, { deckId }), loadDecks(supabase, user.id)]);
  return <StatsView stats={stats} deckId={deckId} decks={flatten(deckTree(decks)).map((d) => ({ id: d.id, path: d.path, depth: d.depth }))} />;
}
