import type { Deck } from "./types";

/**
 * The deck tree. Paths join names with "::" ("Maths::Lois"), the way the
 * connector and the import name a deck.
 */

export type DeckNode = Deck & { depth: number; path: string; children: DeckNode[] };

/** Roots first, siblings by position then name; orphans (bad parent) become roots. */
export function deckTree(decks: Deck[]): DeckNode[] {
  const byId = new Map(decks.map((d) => [d.id, { ...d, depth: 0, path: d.name, children: [] as DeckNode[] }]));
  const roots: DeckNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const order = (a: DeckNode, b: DeckNode) => a.position - b.position || a.name.localeCompare(b.name);
  const walk = (list: DeckNode[], depth: number, prefix: string) => {
    list.sort(order);
    for (const n of list) {
      n.depth = depth;
      n.path = prefix ? `${prefix}::${n.name}` : n.name;
      walk(n.children, depth + 1, n.path);
    }
  };
  walk(roots, 0, "");
  return roots;
}

/** The tree flattened in display order. */
export function flatten(tree: DeckNode[]): DeckNode[] {
  const out: DeckNode[] = [];
  const walk = (list: DeckNode[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** A deck and everything under it. */
export function subtreeIds(decks: Deck[], rootId: string): string[] {
  const kids = new Map<string, string[]>();
  for (const d of decks) {
    if (!d.parent_id) continue;
    const list = kids.get(d.parent_id) ?? [];
    list.push(d.id);
    kids.set(d.parent_id, list);
  }
  const out: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    stack.push(...(kids.get(id) ?? []));
  }
  return out;
}

/** "Maths::Lois" for a deck id, or null. */
export function deckPath(decks: Deck[], id: string): string | null {
  return flatten(deckTree(decks)).find((d) => d.id === id)?.path ?? null;
}

/** A deck by id, or by path ("Maths::Lois", any case, spaces around "::" ignored). */
export function findDeck(decks: Deck[], ref: string): Deck | null {
  const byId = decks.find((d) => d.id === ref);
  if (byId) return byId;
  const key = normalizePath(ref);
  return flatten(deckTree(decks)).find((d) => normalizePath(d.path) === key) ?? null;
}

export function normalizePath(path: string): string {
  return path
    .split("::")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .join("::");
}

/** Split a path into names, for creating the decks it needs. */
export function pathNames(path: string): string[] {
  return path
    .split("::")
    .map((p) => p.trim())
    .filter(Boolean);
}
