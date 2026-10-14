import { requireUser } from "@/server/auth";
import { loadDecks, loadTags, searchNotes, type SearchFilters } from "@/server/flashcards/data";
import { deckTree, flatten } from "@/lib/flashcards/decks";
import { isCardState, isNoteKind } from "@/lib/flashcards/types";
import { Browser } from "@/components/flashcards/Browser";

export const metadata = { title: "Browse — Flashcards" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Filters live in the URL, so a filtered view can be bookmarked or linked. */
function filtersOf(sp: Record<string, string | string[] | undefined>): SearchFilters {
  const state = first(sp.state);
  const kind = first(sp.kind);
  const due = first(sp.due);
  const deck = first(sp.deck);
  const by = first(sp.by);
  return {
    q: first(sp.q)?.slice(0, 200) || undefined,
    deckId: deck && UUID.test(deck) ? deck : undefined,
    tag: first(sp.tag)?.slice(0, 60) || undefined,
    kind: isNoteKind(kind) ? kind : undefined,
    state: isCardState(state) || state === "suspended" || state === "flagged" || state === "leech" ? state : undefined,
    due: due === "today" || due === "overdue" ? due : undefined,
    source: first(sp.source) === "1" || undefined,
    createdBy: by === "claude" || by === "user" ? by : undefined,
    trash: first(sp.trash) === "1" || undefined,
  };
}

export default async function BrowsePage({ searchParams }: PageProps<"/flashcards/browse">) {
  const filters = filtersOf(await searchParams);
  const { supabase, user } = await requireUser();
  const [result, decks, tags] = await Promise.all([
    searchNotes(supabase, user.id, filters, 0),
    loadDecks(supabase, user.id),
    loadTags(supabase),
  ]);
  const deckList = flatten(deckTree(decks)).map((d) => ({ id: d.id, path: d.path, depth: d.depth }));
  return (
    <Browser
      key={JSON.stringify(filters)}
      filters={filters}
      initial={result}
      decks={deckList}
      tags={tags}
      now={new Date().toISOString()}
    />
  );
}
