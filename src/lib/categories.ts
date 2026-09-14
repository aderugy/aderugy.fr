import type { Category } from "./types";

export const DEFAULT_COLOR = "#64748b";

export const PALETTE = [
  "#3b5bdb", // indigo
  "#0ca678", // teal
  "#e8590c", // orange
  "#ae3ec9", // purple
  "#1c7ed6", // blue
  "#2f9e44", // green
  "#e03131", // red
  "#f08c00", // amber
  "#0c8599", // cyan
  "#64748b", // slate
];

export type CategoryNode = Category & {
  children: CategoryNode[];
  depth: number;
  /** Own color, or the nearest ancestor's. */
  effectiveColor: string;
  /** "poker > session review" */
  path: string;
};

/** Build the tree, resolving inherited colors and full paths in one pass. */
export function buildTree(categories: Category[]): CategoryNode[] {
  const byParent = new Map<string | null, Category[]>();
  for (const c of categories) {
    const key = c.parent_id;
    const list = byParent.get(key);
    if (list) list.push(c);
    else byParent.set(key, [c]);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }

  const walk = (
    parentId: string | null,
    depth: number,
    inheritedColor: string,
    prefix: string,
  ): CategoryNode[] =>
    (byParent.get(parentId) ?? []).map((c) => {
      const effectiveColor = c.color ?? inheritedColor;
      const path = prefix ? `${prefix} > ${c.name}` : c.name;
      return {
        ...c,
        depth,
        effectiveColor,
        path,
        children: walk(c.id, depth + 1, effectiveColor, path),
      };
    });

  return walk(null, 0, DEFAULT_COLOR, "");
}

/** Depth-first flattening, useful for <select> and lookups. */
export function flattenTree(nodes: CategoryNode[]): CategoryNode[] {
  const out: CategoryNode[] = [];
  const visit = (list: CategoryNode[]) => {
    for (const n of list) {
      out.push(n);
      visit(n.children);
    }
  };
  visit(nodes);
  return out;
}

export function categoryIndex(categories: Category[]) {
  const flat = flattenTree(buildTree(categories));
  return new Map(flat.map((c) => [c.id, c]));
}

/** Every descendant id of `id`, inclusive — used for filtering by subtree. */
export function subtreeIds(categories: Category[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const c of categories) {
    if (!c.parent_id) continue;
    const list = children.get(c.parent_id);
    if (list) list.push(c.id);
    else children.set(c.parent_id, [c.id]);
  }
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    out.add(cur);
    for (const child of children.get(cur) ?? []) stack.push(child);
  }
  return out;
}
