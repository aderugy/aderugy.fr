/**
 * Navigation model for study mode: the tree seen one "stop" at a time.
 *
 * A spot's tree alternates decisions, actions and cards, and most nodes have a
 * single child (an action leads to the next decision, a card to the decision
 * dealt on it). Stopping on each of them would mean three clicks per street
 * for nothing, so study mode only stops where something is chosen:
 *
 * - the root (the setup and its notes);
 * - every decision (a grid, options);
 * - any other node with several children — typically the action that closes a
 *   betting round, with one child per runout — and any node where cards are
 *   dealt next, even a single runout (the runouts report and the other cards
 *   are picked there);
 * - leaves (a terminal action, an undeveloped branch).
 *
 * Nodes with exactly one child are *folded*: descending walks through them to
 * the next stop, and the stop they lead to shows their notes "along the way".
 * Pure functions only.
 */

import { asAction, asStrategy, type PokerNode, type StrategyAction } from "./types";

export type StudyTree = {
  rootId: string;
  node: (id: string) => PokerNode | undefined;
  /** Children in display order; `rootId` gives the top-level nodes. */
  kids: (id: string) => PokerNode[];
  /** Parent id: top-level nodes hang from `rootId`, the root has none. */
  parent: (id: string) => string | null;
};

export function studyTree(nodes: PokerNode[], rootId: string): StudyTree {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, PokerNode[]>();
  for (const n of nodes) {
    const key = n.parent_id ?? rootId;
    const list = kids.get(key);
    if (list) list.push(n);
    else kids.set(key, [n]);
  }
  for (const list of kids.values()) {
    list.sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
  }
  return {
    rootId,
    node: (id) => byId.get(id),
    kids: (id) => kids.get(id) ?? [],
    parent: (id) => {
      if (id === rootId) return null;
      const n = byId.get(id);
      if (!n) return null;
      return n.parent_id ?? rootId;
    },
  };
}

/** Whether study mode stops on this node (see the module comment). */
export function isStop(t: StudyTree, id: string): boolean {
  if (id === t.rootId) return true;
  const n = t.node(id);
  if (!n) return false;
  if (n.type === "strategy") return true;
  return t.kids(id).length !== 1 || dealsCards(t, id);
}

/** The node's children are cards (the next street is dealt below it). */
function dealsCards(t: StudyTree, id: string): boolean {
  return t.kids(id).some((k) => k.type === "flop" || k.type === "turn" || k.type === "river");
}

export type StopKind = "root" | "decision" | "branches" | "leaf";

export function stopKind(t: StudyTree, id: string): StopKind {
  if (id === t.rootId) return "root";
  if (t.node(id)?.type === "strategy") return "decision";
  return t.kids(id).length > 1 || dealsCards(t, id) ? "branches" : "leaf";
}

/** From `id` down through single-child nodes to the first stop, and the nodes walked through. */
export function descend(t: StudyTree, id: string): { stop: string; folded: PokerNode[] } {
  const folded: PokerNode[] = [];
  let cur = id;
  while (!isStop(t, cur)) {
    const n = t.node(cur);
    const next = t.kids(cur)[0];
    if (!n || !next) break;
    folded.push(n);
    cur = next.id;
  }
  return { stop: cur, folded };
}

/** Where study mode opens: the first stop below the root, unless the root branches. */
export function entryStop(t: StudyTree): string {
  const top = t.kids(t.rootId);
  return top.length === 1 ? descend(t, top[0].id).stop : t.rootId;
}

/** The stop to show for any node id (a folded node shows the stop it leads to). */
export function resolveStop(t: StudyTree, id: string | null | undefined): string {
  if (!id || (id !== t.rootId && !t.node(id))) return entryStop(t);
  return descend(t, id).stop;
}

/** The nearest stop above `id`, or null at the root. */
export function parentStop(t: StudyTree, id: string): string | null {
  let cur = t.parent(id);
  while (cur && !isStop(t, cur)) cur = t.parent(cur);
  return cur;
}

/** Ids from the root down to `id`, both included. */
export function pathTo(t: StudyTree, id: string): string[] {
  const out: string[] = [];
  let cur: string | null = id;
  while (cur && out.length < 10_000) {
    out.push(cur);
    cur = t.parent(cur);
  }
  return out.reverse();
}

export type StudyTarget = {
  /** The child the target goes through; null for an option with no branch yet. */
  via: PokerNode | null;
  /** At a decision: the option taken (null for a child that isn't one of its options). */
  option: StrategyAction | null;
  /** Index of `option` in the decision's actions (grid column), -1 otherwise. */
  optionIndex: number;
  /** The stop it leads to; null when not developed. */
  stop: string | null;
  /** Nodes walked through from `via` to `stop` (`via` included unless it is the stop). */
  folded: PokerNode[];
};

/**
 * What can be reached from a stop, in display order. A decision lists every
 * option — undeveloped ones with `stop: null` — then any child that isn't one
 * of its options; other stops list their children.
 */
export function targets(t: StudyTree, stopId: string): StudyTarget[] {
  const n = t.node(stopId);
  const kids = t.kids(stopId);
  const reach = (via: PokerNode) => {
    const { stop, folded } = descend(t, via.id);
    return { stop, folded };
  };
  if (n?.type !== "strategy") {
    return kids.map((k) => ({ via: k, option: null, optionIndex: -1, ...reach(k) }));
  }
  const actions = asStrategy(n).actions;
  const linked = new Map<string, PokerNode>();
  for (const k of kids) {
    if (k.type !== "action") continue;
    const aid = asAction(k).strategyActionId;
    if (aid && !linked.has(aid)) linked.set(aid, k);
  }
  const out: StudyTarget[] = actions.map((a, i) => {
    const via = linked.get(a.id) ?? null;
    return via
      ? { via, option: a, optionIndex: i, ...reach(via) }
      : { via: null, option: a, optionIndex: i, stop: null, folded: [] };
  });
  const used = new Set([...linked.values()].map((k) => k.id));
  for (const k of kids) {
    if (!used.has(k.id)) out.push({ via: k, option: null, optionIndex: -1, ...reach(k) });
  }
  return out;
}

/** The stop above `stopId`, its targets, and which of them leads here. */
export function siblings(
  t: StudyTree,
  stopId: string,
): { parent: string | null; targets: StudyTarget[]; index: number } {
  const parent = parentStop(t, stopId);
  if (!parent) return { parent: null, targets: [], index: -1 };
  const ts = targets(t, parent);
  return { parent, targets: ts, index: ts.findIndex((x) => x.stop === stopId) };
}

/** The next developed sibling in direction `step` (±1), or null. */
export function siblingStop(t: StudyTree, stopId: string, step: 1 | -1): string | null {
  const { targets: ts, index } = siblings(t, stopId);
  if (index < 0) return null;
  for (let i = index + step; i >= 0 && i < ts.length; i += step) {
    if (ts[i].stop) return ts[i].stop;
  }
  return null;
}
