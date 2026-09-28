/**
 * Playing one hand through a spot's tree, from an entry node until the hand
 * ends. Pure functions; randomness is injected so tests can seed it.
 *
 * - Cards: one of the runouts under the current node, uniformly, among those
 *   that don't use a card already out (board, hero's hand).
 * - Villain: an option drawn from the global frequencies of his grid (board
 *   and hero's cards removed), among the options that have a branch only.
 *   With no grid, uniformly among the branches.
 * - Hero: his hand is dealt at his first decision, from that node's range.
 *   Every decision shows a roll; the hand follows the option he chooses.
 * - It ends on a terminal (fold, showdown, all-in), or where the tree stops:
 *   no node below (end of solution), no branch for hero's option (branch not
 *   developed), no strategy for hero's hand (off range), no runout left
 *   (no runout), or, with the option on, when a street's betting is over
 *   (end of street).
 * - At showdown, villain's hand is drawn from his last decision with a grid,
 *   in proportion to how often each hand took the option he took there.
 */

import { comboBlocked, comboCards, comboToHand } from "../solver/cards";
import { globalFrequencies, comboVector } from "../solver/strategy";
import {
  initialState,
  nodeState,
  walkPath,
  type HandState,
  type NodeState,
} from "../solver/gameState";
import type { Seat } from "../solver/seats";
import {
  asStrategy,
  type PokerNode,
  type SpotSetup,
  type StrategyAction,
  type StrategyWeights,
} from "../solver/types";
import { comboPool, pickWeighted } from "./deal";
import { playableFreqs, rollRng, scoreAnswer, type Scored } from "./score";
import type { DrillSpot, EndReason } from "./types";

export type Tree = {
  spotId: string;
  setup: SpotSetup & { players: [Seat, Seat] };
  byId: Map<string, PokerNode>;
  children: Map<string | null, PokerNode[]>;
  weights: Record<string, StrategyWeights>;
};

export function buildTree(spot: DrillSpot, weights: Record<string, StrategyWeights>): Tree | null {
  if (!spot.setup.players) return null;
  const byId = new Map(spot.nodes.map((n) => [n.id, n]));
  const children = new Map<string | null, PokerNode[]>();
  for (const n of spot.nodes) {
    const list = children.get(n.parent_id);
    if (list) list.push(n);
    else children.set(n.parent_id, [n]);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
  }
  return {
    spotId: spot.spotId,
    setup: spot.setup as SpotSetup & { players: [Seat, Seat] },
    byId,
    children,
    weights,
  };
}

/** What happened between hero's decisions, each with the state right after it (for replaying it on the table). */
export type Step =
  | { type: "card"; nodeId: string; cards: string[]; after: HandState }
  | { type: "villain"; nodeId: string; actionNodeId: string; seat: Seat; label: string; actionIndex: number; after: HandState }
  | { type: "hero"; nodeId: string; decision: number; after: HandState };

/** A hero decision, asked then answered. */
export type Decision = {
  nodeId: string;
  actions: StrategyAction[];
  vector: number[];
  rng: number;
  /** The state hero faced. */
  state: HandState;
  chosenIndex: number | null;
  scored: Scored | null;
};

export type HandEnd = { reason: EndReason; nodeId: string | null };

export type Hand = {
  id: string;
  spotId: string;
  entryId: string;
  heroSeat: Seat;
  villainSeat: Seat;
  combo: string | null;
  villainCombo: string | null;
  state: HandState;
  /** The state at the entry node, before any step. */
  startState: HandState;
  steps: Step[];
  decisions: Decision[];
  /** The decision waiting for hero's answer. */
  pending: Decision | null;
  end: HandEnd | null;
};

export type PlayOptions = { stopAtStreetEnd?: boolean; rand?: () => number };

/* ------------------------------------------------------------------ helpers */

function pathTo(tree: Tree, nodeId: string): PokerNode[] | null {
  const out: PokerNode[] = [];
  const seen = new Set<string>();
  let cur: string | null = nodeId;
  while (cur) {
    const n = tree.byId.get(cur);
    if (!n || seen.has(cur)) return null;
    seen.add(cur);
    out.push(n);
    cur = n.parent_id;
  }
  return out.reverse();
}

function kidsOf(tree: Tree, id: string): PokerNode[] {
  return tree.children.get(id) ?? [];
}

function hasRange(w: StrategyWeights | undefined): w is StrategyWeights {
  if (!w) return false;
  return [...Object.values(w.hands), ...Object.values(w.combos)].some((v) => v.some((x) => Number(x) > 0));
}

function deadCards(h: Hand): Set<string> {
  const dead = new Set(h.state.board);
  if (h.combo) for (const c of comboCards(h.combo)) dead.add(c);
  return dead;
}

/** The option branches of a decision that can be played from this state. */
function branches(tree: Tree, decision: PokerNode, state: HandState): { index: number; node: PokerNode; ns: NodeState }[] {
  const actions = asStrategy(decision).actions;
  const out: { index: number; node: PokerNode; ns: NodeState }[] = [];
  for (const kid of kidsOf(tree, decision.id)) {
    if (kid.type !== "action") continue;
    const id = (kid.data as { strategyActionId?: string | null }).strategyActionId;
    const index = actions.findIndex((a) => a.id === id);
    if (index < 0 || out.some((b) => b.index === index)) continue;
    const ns = nodeState(state, kid, decision, false);
    if (ns.error) continue;
    out.push({ index, node: kid, ns });
  }
  return out;
}

function ended(h: Hand, reason: EndReason, nodeId: string | null): Hand {
  return { ...h, pending: null, end: { reason, nodeId } };
}

/* -------------------------------------------------------------------- walk */

/**
 * Go on from `node`, where the hand's state is `h.state` (the state after
 * that node), until hero has to decide or the hand ends.
 */
function continueFrom(tree: Tree, h: Hand, node: PokerNode, opts: PlayOptions): Hand {
  const rand = opts.rand ?? Math.random;
  // Bounded: a tree is finite, but never trust stored data to be acyclic.
  for (let guard = 0; guard < 500; guard++) {
    if (node.type === "strategy") return decide(tree, h, node, opts);

    const t = h.state.terminal;
    if (t) return ended(h, t.kind, node.id);
    if (opts.stopAtStreetEnd && h.state.status === "deal" && h.decisions.length > 0) {
      return ended(h, "end_of_street", node.id);
    }

    const kids = kidsOf(tree, node.id);
    const cards = kids.filter((k) => k.type === "flop" || k.type === "turn" || k.type === "river");
    if (cards.length > 0) {
      const dead = deadCards(h);
      const live = cards
        .map((k) => ({ k, ns: nodeState(h.state, k, node, false) }))
        .filter(({ ns }) => !ns.error)
        .filter(({ ns }) => ns.state.board.slice(h.state.board.length).every((c) => !dead.has(c)));
      const pick = pickWeighted(live, () => 1, rand);
      if (!pick) return ended(h, "no_runout", node.id);
      h = {
        ...h,
        state: pick.ns.state,
        steps: [
          ...h.steps,
          { type: "card", nodeId: pick.k.id, cards: pick.ns.state.board.slice(h.state.board.length), after: pick.ns.state },
        ],
      };
      node = pick.k;
      continue;
    }

    const next = kids.find((k) => k.type === "strategy" && !nodeState(h.state, k, node, false).error);
    if (!next) return ended(h, "end_of_solution", node.id);
    node = next;
  }
  return ended(h, "end_of_solution", node.id);
}

function decide(tree: Tree, h: Hand, node: PokerNode, opts: PlayOptions): Hand {
  const rand = opts.rand ?? Math.random;
  const actor = h.state.toAct;
  const actions = asStrategy(node).actions;
  const weights = tree.weights[node.id];

  if (actor === h.villainSeat) {
    const open = branches(tree, node, h.state);
    if (open.length === 0) return ended(h, "end_of_solution", node.id);
    const freqs = hasRange(weights) ? globalFrequencies(weights, actions.length, deadCards(h)) : null;
    let pick: (typeof open)[number] | null;
    if (freqs) {
      pick = pickWeighted(open, (b) => freqs[b.index] ?? 0, rand);
      // Every developed option is at 0%: villain never goes down the tree here.
      if (!pick) return ended(h, "end_of_solution", node.id);
    } else {
      pick = pickWeighted(open, () => 1, rand);
    }
    if (!pick) return ended(h, "end_of_solution", node.id);
    const next: Hand = {
      ...h,
      state: pick.ns.state,
      steps: [
        ...h.steps,
        {
          type: "villain",
          nodeId: node.id,
          actionNodeId: pick.node.id,
          seat: actor,
          label: actions[pick.index].label,
          actionIndex: pick.index,
          after: pick.ns.state,
        },
      ],
    };
    return continueFrom(tree, next, pick.node, opts);
  }

  // Hero's decision.
  if (!hasRange(weights) || actions.length === 0) return ended(h, "end_of_solution", node.id);
  let combo = h.combo;
  let vector: number[];
  if (!combo) {
    const pool = comboPool(weights, actions.length, new Set(h.state.board)).filter((e) => playableFreqs(e.vector) !== null);
    const entry = pickWeighted(pool, (e) => e.weight, rand);
    if (!entry) return ended(h, "off_range", node.id);
    combo = entry.combo;
    vector = entry.vector;
  } else {
    vector = comboVector(weights, combo, comboToHand(combo), actions.length);
    if (playableFreqs(vector) === null) return ended({ ...h, combo }, "off_range", node.id);
  }
  const decision: Decision = {
    nodeId: node.id,
    actions,
    vector,
    rng: rollRng(rand),
    state: h.state,
    chosenIndex: null,
    scored: null,
  };
  return { ...h, combo, pending: decision };
}

/* ------------------------------------------------------------------ public */

/**
 * Start a hand at `entryId`. Null when the entry can't start a hand (setup,
 * tree error, hand already over there).
 */
export function startHand(
  tree: Tree,
  entryId: string,
  heroSeat: Seat,
  id: string,
  opts: PlayOptions = {},
): Hand | null {
  const path = pathTo(tree, entryId);
  if (!path) return null;
  const states = walkPath(tree.setup, path);
  if (states.some((s) => s.error)) return null;
  const entry = path[path.length - 1];
  const [a, b] = tree.setup.players;
  if (heroSeat !== a && heroSeat !== b) return null;
  const start = states[states.length - 1]?.state ?? initialState(tree.setup);
  const hand: Hand = {
    id,
    spotId: tree.spotId,
    entryId,
    heroSeat,
    villainSeat: heroSeat === a ? b : a,
    combo: null,
    villainCombo: null,
    state: start,
    startState: start,
    steps: [],
    decisions: [],
    pending: null,
    end: null,
  };
  if (hand.state.status === "over") return null;
  return finish(tree, continueFrom(tree, hand, entry, opts), opts);
}

/** Hero picks option `index` at the pending decision. */
export function answer(tree: Tree, h: Hand, index: number, opts: PlayOptions = {}): Hand {
  const d = h.pending;
  if (!d || h.end) return h;
  const scored = scoreAnswer(d.vector, d.rng, index);
  const done: Decision = { ...d, chosenIndex: index, scored };
  const node = tree.byId.get(d.nodeId) as PokerNode;
  const next: Hand = { ...h, pending: null, decisions: [...h.decisions, done] };
  const branch = branches(tree, node, d.state).find((b) => b.index === index);
  if (!branch) {
    const stuck: Hand = { ...next, steps: [...h.steps, { type: "hero", nodeId: d.nodeId, decision: h.decisions.length, after: d.state }] };
    return finish(tree, ended(stuck, "branch_not_developed", d.nodeId), opts);
  }
  const played: Hand = {
    ...next,
    state: branch.ns.state,
    steps: [...h.steps, { type: "hero", nodeId: d.nodeId, decision: h.decisions.length, after: branch.ns.state }],
  };
  return finish(tree, continueFrom(tree, played, branch.node, opts), opts);
}

/** At showdown / all-in, draw villain's hand from his last decision with a grid. */
function finish(tree: Tree, h: Hand, opts: PlayOptions): Hand {
  if (!h.end || (h.end.reason !== "showdown" && h.end.reason !== "allin")) return h;
  const rand = opts.rand ?? Math.random;
  const lastVillain = [...h.steps]
    .reverse()
    .find((s): s is Extract<Step, { type: "villain" }> => s.type === "villain" && hasRange(tree.weights[s.nodeId]));
  if (!lastVillain) return h;
  const weights = tree.weights[lastVillain.nodeId];
  const len = asStrategy(tree.byId.get(lastVillain.nodeId) as PokerNode).actions.length;
  const dead = deadCards(h);
  const pool = comboPool(weights, len, dead).filter((e) => !comboBlocked(e.combo, dead));
  const pick = pickWeighted(pool, (e) => e.vector[lastVillain.actionIndex] ?? 0, rand);
  return pick ? { ...h, villainCombo: pick.combo } : h;
}

/** Decisions answered and how many were correct. */
export function handScore(h: Hand): { decisions: number; correct: number } {
  const decisions = h.decisions.filter((d) => d.scored).length;
  const correct = h.decisions.filter((d) => d.scored?.grade === "correct").length;
  return { decisions, correct };
}
