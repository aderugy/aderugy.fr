/**
 * Pure top-down layout for the loaded slice of a spot's node tree.
 *
 * Only the nodes passed in are placed; a node whose children are not loaded is
 * treated as a leaf. Leaves take successive horizontal slots and parents centre
 * over their children — the classic tidy-tree first pass, which is plenty for a
 * hand-authored solver tree.
 */

import type { PokerNode } from "./types";

export const NODE_W = 190;
export const NODE_H = 96;
export const H_GAP = 36;
export const V_GAP = 72;
export const PADDING = 48;

export type Placement = { x: number; y: number };

export type Layout = {
  positions: Map<string, Placement>;
  edges: { from: string; to: string }[];
  width: number;
  height: number;
};

export function layoutTree(nodes: PokerNode[]): Layout {
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

  const positions = new Map<string, Placement>();
  const edges: { from: string; to: string }[] = [];
  let slot = 0;

  const stepX = NODE_W + H_GAP;
  const stepY = NODE_H + V_GAP;

  const place = (node: PokerNode, depth: number): number => {
    const kids = children.get(node.id) ?? [];
    let x: number;
    if (kids.length === 0) {
      x = slot * stepX;
      slot += 1;
    } else {
      const xs = kids.map((k) => {
        edges.push({ from: node.id, to: k.id });
        return place(k, depth + 1);
      });
      x = (xs[0] + xs[xs.length - 1]) / 2;
    }
    positions.set(node.id, { x: PADDING + x, y: PADDING + depth * stepY });
    return x;
  };

  for (const root of roots) place(root, 0);

  let maxX = 0;
  let maxY = 0;
  for (const p of positions.values()) {
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  return {
    positions,
    edges,
    width: maxX + NODE_W + PADDING,
    height: maxY + NODE_H + PADDING,
  };
}
