"use server";

import { refresh } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser, fail, type ActionResult } from "@/server/auth";
import { isSeat, type Seat } from "@/lib/solver/seats";
import { vectorTotal } from "@/lib/solver/strategy";
import { initialState, nodeState, walkPath, type HandState } from "@/lib/solver/gameState";
import { asSetup, type PokerNode, type SpotSetup, type StrategyWeights } from "@/lib/solver/types";
import { compatibility, resolveEntry } from "@/lib/trainer/resolve";
import { entryLabel } from "@/lib/trainer/labels";
import type { Drill, DrillSpot, EntryContext, Feedback, Trainer, TrainerNodeRow } from "@/lib/trainer/types";

type CreatedResult = { ok: true; id: string } | { ok: false; error: string };

const NODE_SELECT = "id, spot_id, parent_id, type, position, data, created_at, updated_at";
const TRAINER_SELECT =
  "id, name, hero_seat, villain_seat, pot_bb, stack_bb, street, stop_at_street_end, feedback, archived, created_at, updated_at";

/* ------------------------------------------------------------------ helpers */

function seatsOrThrow(hero: unknown, villain: unknown): [Seat, Seat] {
  if (!isSeat(hero) || !isSeat(villain)) throw new Error("Pick hero and villain seats");
  if (hero === villain) throw new Error("Hero and villain must sit in different seats");
  return [hero, villain];
}

function feedbackOrThrow(value: unknown): Feedback {
  if (value === "each" || value === "hand_end") return value;
  throw new Error("Unknown feedback mode");
}

function normalizeWeights(raw: unknown): StrategyWeights {
  const w = (raw ?? {}) as Partial<StrategyWeights>;
  return { hands: w.hands ?? {}, combos: w.combos ?? {} };
}

function hasRange(w: StrategyWeights): boolean {
  return [...Object.values(w.hands), ...Object.values(w.combos)].some((v) => vectorTotal(v) > 0);
}

/** Every node of these spots, keyed by id — enough to walk any path in them. */
async function loadSpotNodes(
  supabase: SupabaseClient,
  userId: string,
  spotIds: string[],
): Promise<Record<string, PokerNode>> {
  if (spotIds.length === 0) return {};
  const { data, error } = await supabase
    .from("poker_nodes")
    .select(NODE_SELECT)
    .eq("user_id", userId)
    .in("spot_id", spotIds);
  if (error) throw error;
  return Object.fromEntries(((data ?? []) as PokerNode[]).map((n) => [n.id, n]));
}

async function loadSetups(
  supabase: SupabaseClient,
  userId: string,
  spotIds: string[],
): Promise<Map<string, { name: string; setup: SpotSetup }>> {
  if (spotIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("poker_spots")
    .select("id, name, setup")
    .eq("user_id", userId)
    .in("id", spotIds);
  if (error) throw error;
  return new Map((data ?? []).map((s) => [s.id as string, { name: s.name as string, setup: asSetup(s.setup) }]));
}

function pathFrom(nodes: Record<string, PokerNode>, nodeId: string): PokerNode[] | null {
  const out: PokerNode[] = [];
  const seen = new Set<string>();
  let cur: string | null = nodeId;
  while (cur) {
    const n: PokerNode | undefined = nodes[cur];
    if (!n || seen.has(cur)) return null;
    seen.add(cur);
    out.push(n);
    cur = n.parent_id;
  }
  return out.reverse();
}

function childrenIndex(nodes: Record<string, PokerNode>): Map<string, PokerNode[]> {
  const m = new Map<string, PokerNode[]>();
  for (const n of Object.values(nodes)) {
    if (!n.parent_id) continue;
    const list = m.get(n.parent_id);
    if (list) list.push(n);
    else m.set(n.parent_id, [n]);
  }
  return m;
}

/** The entry and everything below it. */
function subtree(kids: Map<string, PokerNode[]>, root: PokerNode): PokerNode[] {
  const out: PokerNode[] = [];
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    stack.push(...(kids.get(n.id) ?? []));
  }
  return out;
}

/**
 * The decision nodes below an entry where `hero` acts — the only nodes a hand
 * from there can ask about. Walked with the engine, so an invalid branch
 * doesn't count.
 */
function heroDecisions(
  kids: Map<string, PokerNode[]>,
  entry: PokerNode,
  parent: PokerNode | null,
  before: HandState,
  hero: Seat,
): string[] {
  const out: string[] = [];
  const visit = (node: PokerNode, par: PokerNode | null, state: HandState) => {
    const ns = nodeState(state, node, par, false);
    if (ns.error) return;
    if (node.type === "strategy" && ns.actor === hero) out.push(node.id);
    for (const k of kids.get(node.id) ?? []) visit(k, node, ns.state);
  };
  visit(entry, parent, before);
  return out;
}

/** Hero's decisions reachable from the last node of `path` (the entry). */
function entryDecisions(
  setup: SpotSetup & { players: [Seat, Seat] },
  kids: Map<string, PokerNode[]>,
  path: PokerNode[],
  hero: Seat,
): string[] {
  const before =
    path.length > 1 ? walkPath(setup, path.slice(0, -1)).at(-1)!.state : initialState(setup);
  return heroDecisions(kids, path[path.length - 1], path.length > 1 ? path[path.length - 2] : null, before, hero);
}

function sameContext(row: TrainerNodeRow, ctx: EntryContext): boolean {
  return (
    row.street === ctx.street &&
    JSON.stringify(row.board) === JSON.stringify(ctx.board) &&
    JSON.stringify(row.line) === JSON.stringify(ctx.line)
  );
}

/** Read `node_id → weights` in slices, so a big tree never makes a huge query string. */
async function loadWeights(
  supabase: SupabaseClient,
  userId: string,
  nodeIds: string[],
): Promise<Record<string, StrategyWeights>> {
  const out: Record<string, StrategyWeights> = {};
  for (let i = 0; i < nodeIds.length; i += 100) {
    const slice = nodeIds.slice(i, i + 100);
    const { data, error } = await supabase
      .from("poker_strategies")
      .select("node_id, weights")
      .eq("user_id", userId)
      .in("node_id", slice);
    if (error) throw error;
    for (const r of data ?? []) {
      const w = normalizeWeights(r.weights);
      if (hasRange(w)) out[r.node_id as string] = w;
    }
  }
  return out;
}

/* ----------------------------------------------------------------- trainers */

export async function createTrainer(input: {
  name: string;
  heroSeat: string;
  villainSeat: string;
  stopAtStreetEnd?: boolean;
  feedback?: Feedback;
  /** Start hands at this node right away (the "New trainer…" entry in Solver notes). */
  nodeId?: string;
}): Promise<CreatedResult> {
  try {
    const { supabase, user } = await requireUser();
    const name = input.name.trim();
    if (!name) return { ok: false, error: "Name is required" };
    const [hero, villain] = seatsOrThrow(input.heroSeat, input.villainSeat);

    const { data, error } = await supabase
      .from("poker_trainers")
      .insert({
        user_id: user.id,
        name,
        hero_seat: hero,
        villain_seat: villain,
        pot_bb: null,
        stop_at_street_end: !!input.stopAtStreetEnd,
        feedback: feedbackOrThrow(input.feedback ?? "each"),
      })
      .select("id")
      .single();
    if (error) throw error;
    const id = data.id as string;

    if (input.nodeId) {
      const added = await addNodeToTrainer({ trainerId: id, nodeId: input.nodeId });
      if (!added.ok) {
        await supabase.from("poker_trainers").delete().eq("id", id).eq("user_id", user.id);
        return { ok: false, error: added.error };
      }
    }

    refresh();
    return { ok: true, id };
  } catch (e) {
    return fail(e) as CreatedResult;
  }
}

export async function updateTrainer(input: {
  id: string;
  name?: string;
  heroSeat?: string;
  villainSeat?: string;
  stopAtStreetEnd?: boolean;
  feedback?: Feedback;
  archived?: boolean;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) return { ok: false, error: "Name is required" };
      patch.name = name;
    }
    if (input.heroSeat !== undefined || input.villainSeat !== undefined) {
      const [hero, villain] = seatsOrThrow(input.heroSeat, input.villainSeat);
      patch.hero_seat = hero;
      patch.villain_seat = villain;
    }
    if (input.stopAtStreetEnd !== undefined) patch.stop_at_street_end = !!input.stopAtStreetEnd;
    if (input.feedback !== undefined) patch.feedback = feedbackOrThrow(input.feedback);
    if (input.archived !== undefined) patch.archived = input.archived;

    const { error } = await supabase
      .from("poker_trainers")
      .update(patch)
      .eq("id", input.id)
      .eq("user_id", user.id);
    if (error) throw error;

    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteTrainer(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const { error } = await supabase
      .from("poker_trainers")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) throw error;
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/* ------------------------------------------------------------------ entries */

/**
 * Start this trainer's hands at a node. The tree is walked here, from the
 * database rows, not from anything the client sends: these checks are the
 * rule, the popover only previews them.
 */
export async function addNodeToTrainer(input: {
  trainerId: string;
  nodeId: string;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();

    const [trainerRes, nodeRes] = await Promise.all([
      supabase.from("poker_trainers").select(TRAINER_SELECT).eq("id", input.trainerId).eq("user_id", user.id).maybeSingle(),
      supabase.from("poker_nodes").select("spot_id").eq("id", input.nodeId).eq("user_id", user.id).maybeSingle(),
    ]);
    if (trainerRes.error) throw trainerRes.error;
    if (nodeRes.error) throw nodeRes.error;
    const trainer = trainerRes.data as Trainer | null;
    if (!trainer) return { ok: false, error: "Trainer not found" };
    if (!nodeRes.data) return { ok: false, error: "Node not found" };
    const spotId = nodeRes.data.spot_id as string;

    const [nodes, setups] = await Promise.all([
      loadSpotNodes(supabase, user.id, [spotId]),
      loadSetups(supabase, user.id, [spotId]),
    ]);
    const setup = setups.get(spotId)?.setup;
    if (!setup) return { ok: false, error: "Spot not found" };
    const path = pathFrom(nodes, input.nodeId);
    if (!path) return { ok: false, error: "Could not read this node's tree" };
    const resolved = resolveEntry(setup, path);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const ctx = resolved.context;

    const fit = compatibility(ctx.players, trainer);
    if (!fit.ok) return { ok: false, error: `Doesn't fit this trainer: ${fit.reason}.` };

    // A hand from here must reach a decision of hero's that has a grid.
    const decisions = entryDecisions({ ...setup, players: ctx.players }, childrenIndex(nodes), path, trainer.hero_seat);
    const weights = await loadWeights(supabase, user.id, decisions);
    if (Object.keys(weights).length === 0) {
      return {
        ok: false,
        error: `No decision of ${trainer.hero_seat} with a strategy below this node — import or paint one first.`,
      };
    }

    const { error } = await supabase.from("poker_trainer_nodes").insert({
      trainer_id: trainer.id,
      node_id: input.nodeId,
      user_id: user.id,
      spot_id: ctx.spotId,
      street: ctx.street,
      board: ctx.board,
      line: ctx.line,
      hero_seat: trainer.hero_seat,
      villain_seat: trainer.villain_seat,
    });
    if (error) {
      if (error.code === "23505") return { ok: false, error: "Already in this trainer" };
      throw error;
    }

    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function removeNodeFromTrainer(input: {
  trainerId: string;
  nodeId: string;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const { error } = await supabase
      .from("poker_trainer_nodes")
      .delete()
      .eq("trainer_id", input.trainerId)
      .eq("node_id", input.nodeId)
      .eq("user_id", user.id);
    if (error) throw error;
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/* ----------------------------------------------------------------- sessions */

export type StartedSession =
  | {
      ok: true;
      sessionId: string;
      drill: Drill;
      skipped: { nodeId: string; reason: string }[];
      updated: number;
    }
  | { ok: false; error: string };

/**
 * Open a session: close any session left open (its end is its last answer),
 * re-walk every entry's tree so an edited card or line is picked up, and load
 * the subtrees and their grids once, so every hand plays in the browser.
 */
export async function startSession(trainerId: string): Promise<StartedSession> {
  try {
    const { supabase, user } = await requireUser();

    const [trainerRes, rowsRes] = await Promise.all([
      supabase.from("poker_trainers").select(TRAINER_SELECT).eq("id", trainerId).eq("user_id", user.id).maybeSingle(),
      supabase
        .from("poker_trainer_nodes")
        .select("trainer_id, node_id, spot_id, street, board, line, hero_seat, villain_seat, weight, resolved_at, added_at")
        .eq("trainer_id", trainerId)
        .eq("user_id", user.id),
    ]);
    if (trainerRes.error) throw trainerRes.error;
    if (rowsRes.error) throw rowsRes.error;
    const trainer = trainerRes.data as Trainer | null;
    if (!trainer) return { ok: false, error: "Trainer not found" };
    const rows = (rowsRes.data ?? []) as TrainerNodeRow[];
    if (rows.length === 0) return { ok: false, error: "Pick where hands start: “Train from here” in Solver notes." };

    await closeStaleSessions(supabase, user.id, trainerId);

    const spotIds = [...new Set(rows.map((r) => r.spot_id))];
    const [nodes, setups] = await Promise.all([
      loadSpotNodes(supabase, user.id, spotIds),
      loadSetups(supabase, user.id, spotIds),
    ]);
    const kids = childrenIndex(nodes);

    const skipped: { nodeId: string; reason: string }[] = [];
    const spots: Record<string, DrillSpot> = {};
    const entries: Drill["entries"] = [];
    const decisionIds = new Set<string>();
    const heroByEntry = new Map<string, string[]>();
    let updated = 0;
    const now = new Date().toISOString();

    for (const row of rows) {
      const spot = setups.get(row.spot_id);
      const path = pathFrom(nodes, row.node_id);
      if (!spot || !path) {
        skipped.push({ nodeId: row.node_id, reason: "Tree could not be read" });
        continue;
      }
      const resolved = resolveEntry(spot.setup, path);
      if (!resolved.ok) {
        skipped.push({ nodeId: row.node_id, reason: resolved.error });
        continue;
      }
      const ctx = resolved.context;
      if (!sameContext(row, ctx)) {
        updated++;
        await supabase
          .from("poker_trainer_nodes")
          .update({ street: ctx.street, board: ctx.board, line: ctx.line, resolved_at: now })
          .eq("trainer_id", trainerId)
          .eq("node_id", row.node_id)
          .eq("user_id", user.id);
      }
      const fit = compatibility(ctx.players, trainer);
      if (!fit.ok) {
        skipped.push({ nodeId: row.node_id, reason: fit.reason });
        continue;
      }
      const entry = path[path.length - 1];
      const heroNodes = entryDecisions({ ...spot.setup, players: ctx.players }, kids, path, trainer.hero_seat);
      if (heroNodes.length === 0) {
        skipped.push({ nodeId: row.node_id, reason: `No decision of ${trainer.hero_seat} below this node` });
        continue;
      }

      const below = subtree(kids, entry);
      for (const n of below) if (n.type === "strategy") decisionIds.add(n.id);
      const drillSpot = (spots[row.spot_id] ??= { spotId: row.spot_id, spotName: spot.name, setup: spot.setup, nodes: [] });
      const have = new Set(drillSpot.nodes.map((n) => n.id));
      for (const n of [...path, ...below]) if (!have.has(n.id)) {
        drillSpot.nodes.push(n);
        have.add(n.id);
      }
      entries.push({ nodeId: row.node_id, spotId: row.spot_id, weight: Number(row.weight) || 1, label: entryLabel(entry) });
      heroByEntry.set(row.node_id, heroNodes);
    }

    // Only entries where hero meets a grid can deal a hand worth playing.
    const weights = await loadWeights(supabase, user.id, [...decisionIds]);
    const playable = entries.filter((e) => {
      const ok = (heroByEntry.get(e.nodeId) ?? []).some((id) => weights[id]);
      if (!ok) skipped.push({ nodeId: e.nodeId, reason: `No strategy for ${trainer.hero_seat} below this node` });
      return ok;
    });

    if (playable.length === 0) {
      return { ok: false, error: `No hand can be dealt right now: ${skipped[0]?.reason ?? "empty"}.` };
    }

    const { data, error } = await supabase
      .from("poker_trainer_sessions")
      .insert({ user_id: user.id, trainer_id: trainerId })
      .select("id")
      .single();
    if (error) throw error;

    return { ok: true, sessionId: data.id as string, drill: { spots, entries: playable, weights }, skipped, updated };
  } catch (e) {
    return fail(e) as StartedSession;
  }
}

/**
 * Sessions left open (tab closed mid-session) end at their last answer; an
 * open session with no answer at all is dropped, it holds nothing.
 */
async function closeStaleSessions(supabase: SupabaseClient, userId: string, trainerId: string) {
  const { data, error } = await supabase
    .from("poker_trainer_sessions")
    .select("id, hands, started_at, last_answer_at")
    .eq("user_id", userId)
    .eq("trainer_id", trainerId)
    .is("ended_at", null);
  if (error) throw error;
  for (const s of data ?? []) {
    if (s.hands === 0) {
      await supabase.from("poker_trainer_sessions").delete().eq("id", s.id).eq("user_id", userId);
    } else {
      await supabase
        .from("poker_trainer_sessions")
        .update({ ended_at: s.last_answer_at ?? s.started_at })
        .eq("id", s.id)
        .eq("user_id", userId);
    }
  }
}

export async function endSession(sessionId: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const { data, error } = await supabase
      .from("poker_trainer_sessions")
      .select("hands")
      .eq("id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { ok: true };
    if (data.hands === 0) {
      await supabase.from("poker_trainer_sessions").delete().eq("id", sessionId).eq("user_id", user.id);
    } else {
      const { error: endError } = await supabase
        .from("poker_trainer_sessions")
        .update({ ended_at: new Date().toISOString() })
        .eq("id", sessionId)
        .eq("user_id", user.id)
        .is("ended_at", null);
      if (endError) throw endError;
    }
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
