/**
 * Pure top-down layout for the loaded slice of a spot's node tree.
 *
 * Only the nodes passed in are placed; a node whose children are not loaded is
 * treated as a leaf. Node boxes can have any size (a strategy bubble in
 * revision mode is much taller than a text note), so the layout works from the
 * measured sizes the canvas feeds back in:
 *
 * - every subtree reserves the width of its widest level, so a wide parent
 *   never overlaps its neighbours' children and vice versa;
 * - each depth is a row as tall as its tallest node, so a tall bubble pushes
 *   the next row down instead of spilling onto it.
 */

import type { PokerNode } from "./types";

/** Default box, used until a node has been measured. */
export const NODE_W = 190;
export const NODE_H = 96;
export const H_GAP = 36;
export const V_GAP = 72;
export const PADDING = 48;

export type Size = { w: number; h: number };

export type Placement = { x: number; y: number; w: number; h: number };

export type Layout = {
  positions: Map<string, Placement>;
  edges: { from: string; to: string }[];
  width: number;
  height: number;
};

export function layoutTree(
  nodes: PokerNode[],
  sizes: Record<string, Size> = {},
): Layout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, PokerNode[]>();
  const roots: PokerNode[] = [];

  for (const n of nodes) {
    if (n.parent_id && byId.has(n.parent_id)) {
      const list = children.get(n.parent_id);
      if (list) list.push(n);
      else children.set(n.parent_id, [n]);
    } else {
      roots.push(n);
    }
  }
  const sortSiblings = (list: PokerNode[]) =>
    list.sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
  sortSiblings(roots);
  for (const list of children.values()) sortSiblings(list);

  const sizeOf = (id: string): Size => sizes[id] ?? { w: NODE_W, h: NODE_H };

  // Pass 1: depth, row heights and subtree widths (post-order).
  const depthOf = new Map<string, number>();
  const rowH: number[] = [];
  const subtreeW = new Map<string, number>();
  const kidsW = new Map<string, number>();

  const measure = (node: PokerNode, depth: number): number => {
    depthOf.set(node.id, depth);
    const { w, h } = sizeOf(node.id);
    rowH[depth] = Math.max(rowH[depth] ?? 0, h);
    const kids = children.get(node.id) ?? [];
    const span =
      kids.reduce((sum, k) => sum + measure(k, depth + 1), 0) +
      Math.max(0, kids.length - 1) * H_GAP;
    kidsW.set(node.id, span);
    const total = Math.max(w, span);
    subtreeW.set(node.id, total);
    return total;
  };
  for (const root of roots) measure(root, 0);

  // Row tops.
  const rowY: number[] = [];
  let y = PADDING;
  for (let d = 0; d < rowH.length; d++) {
    rowY[d] = y;
    y += rowH[d] + V_GAP;
  }

  // Pass 2: place each subtree in its reserved band, parent centred on it.
  const positions = new Map<string, Placement>();
  const edges: { from: string; to: string }[] = [];

  const place = (node: PokerNode, left: number) => {
    const { w, h } = sizeOf(node.id);
    const band = subtreeW.get(node.id)!;
    const center = left + band / 2;
    positions.set(node.id, { x: center - w / 2, y: rowY[depthOf.get(node.id)!], w, h });

    let cursor = center - kidsW.get(node.id)! / 2;
    for (const kid of children.get(node.id) ?? []) {
      edges.push({ from: node.id, to: kid.id });
      place(kid, cursor);
      cursor += subtreeW.get(kid.id)! + H_GAP;
    }
  };

  let cursor = PADDING;
  for (const root of roots) {
    place(root, cursor);
    cursor += subtreeW.get(root.id)! + H_GAP;
  }

  let maxX = 0;
  let maxY = 0;
  for (const p of positions.values()) {
    maxX = Math.max(maxX, p.x + p.w);
    maxY = Math.max(maxY, p.y + p.h);
  }

  return { positions, edges, width: maxX + PADDING, height: maxY + PADDING };
}
