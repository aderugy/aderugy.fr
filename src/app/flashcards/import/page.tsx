import { requireUser } from "@/server/auth";
import { loadDecks } from "@/server/flashcards/data";
import { deckTree, flatten } from "@/lib/flashcards/decks";
import { Importer } from "@/components/flashcards/Importer";

export const metadata = { title: "Import — Flashcards" };

export default async function ImportPage() {
  const { supabase, user } = await requireUser();
  const decks = flatten(deckTree(await loadDecks(supabase, user.id))).map((d) => ({ id: d.id, path: d.path, depth: d.depth }));
  return <Importer decks={decks} />;
}
