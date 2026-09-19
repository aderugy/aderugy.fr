"use server";

import { refresh } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser, fail, type ActionResult } from "@/server/auth";
import { isSeat, type Seat } from "@/lib/solver/seats";
import { vectorTotal } from "@/lib/solver/strategy";
import { asStrategy, type PokerNode, type StrategyWeights } from "@/lib/solver/types";
import { compatibility, resolveNodeContext } from "@/lib/trainer/resolve";
import type { DrillNode, NodeContext, Trainer, TrainerNodeRow } from "@/lib/trainer/types";

type CreatedResult = { ok: true; id: string } | { ok: false; error: string };

const NODE_SELECT = "id, spot_id, parent_id, type, position, data, created_at, updated_at";
const TRAINER_SELECT =
  "id, name, hero_seat, villain_seat, pot_bb, stack_bb, street, archived, created_at, updated_at";

/* ------------------------------------------------------------------ helpers */

function positiveNumber(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

function seatsOrThrow(hero: unknown, villain: unknown): [Seat, Seat] {
  if (!isSeat(hero) || !isSeat(villain)) throw new Error("Pick hero and villain seats");
  if (hero === villain) throw new Error("Hero and villain must sit in different seats");
  return [hero, villain];
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

function sameContext(row: TrainerNodeRow, ctx: NodeContext): boolean {
  return (
    row.street === ctx.street &&
    JSON.stringify(row.board) === JSON.stringify(ctx.board) &&
    JSON.stringify(row.line) === JSON.stringify(ctx.line) &&
    row.hero_seat === ctx.seat &&
    row.villain_seat === ctx.vsSeat
  );
}

/* ----------------------------------------------------------------- trainers */

export async function createTrainer(input: {
  name: string;
  heroSeat: string;
  villainSeat: string;
  potBb: number;
  stackBb: number;
  /** Add this strategy node right away (the "New trainer…" entry in Solver notes). */
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
        pot_bb: positiveNumber(input.potBb, "Pot"),
        stack_bb: positiveNumber(input.stackBb, "Stack"),
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
  potBb?: number;
  stackBb?: number;
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
    if (input.potBb !== undefined) patch.pot_bb = positiveNumber(input.potBb, "Pot");
    if (input.stackBb !== undefined) patch.stack_bb = positiveNumber(input.stackBb, "Stack");
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

/* -------------------------------------------------------------------- nodes */

/**
 * Add a strategy node. The tree is walked here, from the database rows, not
 * from anything the client sends: the checks below are the rule, the popover
 * only previews them.
 */
export async function addNodeToTrainer(input: {
  trainerId: string;
  nodeId: string;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();

    const [trainerRes, nodeRes, stratRes] = await Promise.all([
      supabase.from("poker_trainers").select(TRAINER_SELECT).eq("id", input.trainerId).eq("user_id", user.id).maybeSingle(),
      supabase.from("poker_nodes").select("spot_id").eq("id", input.nodeId).eq("user_id", user.id).maybeSingle(),
      supabase.from("poker_strategies").select("weights").eq("node_id", input.nodeId).eq("user_id", user.id).maybeSingle(),
    ]);
    if (trainerRes.error) throw trainerRes.error;
    if (nodeRes.error) throw nodeRes.error;
    if (stratRes.error) throw stratRes.error;
    const trainer = trainerRes.data as Trainer | null;
    if (!trainer) return { ok: false, error: "Trainer not found" };
    if (!nodeRes.data) return { ok: false, error: "Node not found" };

    const nodes = await loadSpotNodes(supabase, user.id, [nodeRes.data.spot_id as string]);
    const path = pathFrom(nodes, input.nodeId);
    if (!path) return { ok: false, error: "Could not read this node's tree" };
    const resolved = resolveNodeContext(path);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const ctx = resolved.context;

    if (!hasRange(normalizeWeights(stratRes.data?.weights))) {
      return { ok: false, error: "This node has no strategy yet — import or paint one first." };
    }
    if (asStrategy(path[path.length - 1]).actions.length < 2) {
      return { ok: false, error: "This node needs at least two actions to train on." };
    }

    const fit = compatibility(ctx, trainer);
    if (!fit.ok) return { ok: false, error: `Doesn't fit this trainer: ${fit.reason}.` };

    const { error } = await supabase.from("poker_trainer_nodes").insert({
      trainer_id: trainer.id,
      node_id: input.nodeId,
      user_id: user.id,
      spot_id: ctx.spotId,
      street: ctx.street,
      board: ctx.board,
      line: ctx.line,
      hero_seat: ctx.seat,
      villain_seat: ctx.vsSeat,
    });
    if (error) {
      if (error.code === "23505") return { ok: false, error: "Already in this trainer" };
      throw error;
    }

    if (!trainer.street) {
      const { error: streetError } = await supabase
        .from("poker_trainers")
        .update({ street: ctx.street })
        .eq("id", trainer.id)
        .eq("user_id", user.id);
      if (streetError) throw streetError;
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

    // An empty trainer forgets its street, so it can be refilled with any.
    const { count, error: countError } = await supabase
      .from("poker_trainer_nodes")
      .select("node_id", { count: "exact", head: true })
      .eq("trainer_id", input.trainerId)
      .eq("user_id", user.id);
    if (countError) throw countError;
    if (count === 0) {
      await supabase
        .from("poker_trainers")
        .update({ street: null })
        .eq("id", input.trainerId)
        .eq("user_id", user.id);
    }

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
      drill: DrillNode[];
      skipped: { nodeId: string; reason: string }[];
      updated: number;
    }
  | { ok: false; error: string };

/**
 * Open a session: close any session left open (its end is its last answer),
 * re-walk every node's tree so an edited card or line is picked up, and load
 * the strategies once so dealing and grading run in the browser.
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
    if (rows.length === 0) return { ok: false, error: "Add strategy nodes from Solver notes first." };

    await closeStaleSessions(supabase, user.id, trainerId);

    const spotIds = [...new Set(rows.map((r) => r.spot_id))];
    const [nodes, spotsRes, stratRes] = await Promise.all([
      loadSpotNodes(supabase, user.id, spotIds),
      supabase.from("poker_spots").select("id, name").eq("user_id", user.id).in("id", spotIds),
      supabase
        .from("poker_strategies")
        .select("node_id, weights")
        .eq("user_id", user.id)
        .in("node_id", rows.map((r) => r.node_id)),
    ]);
    if (spotsRes.error) throw spotsRes.error;
    if (stratRes.error) throw stratRes.error;
    const spotNames = new Map((spotsRes.data ?? []).map((s) => [s.id as string, s.name as string]));
    const strategies = new Map(
      (stratRes.data ?? []).map((s) => [s.node_id as string, normalizeWeights(s.weights)]),
    );

    const drill: DrillNode[] = [];
    const skipped: { nodeId: string; reason: string }[] = [];
    let updated = 0;
    const now = new Date().toISOString();

    for (const row of rows) {
      const path = pathFrom(nodes, row.node_id);
      if (!path) {
        skipped.push({ nodeId: row.node_id, reason: "Tree could not be read" });
        continue;
      }
      const resolved = resolveNodeContext(path);
      if (!resolved.ok) {
        skipped.push({ nodeId: row.node_id, reason: resolved.error });
        continue;
      }
      const ctx = resolved.context;
      if (!sameContext(row, ctx)) {
        updated++;
        await supabase
          .from("poker_trainer_nodes")
          .update({
            street: ctx.street,
            board: ctx.board,
            line: ctx.line,
            hero_seat: ctx.seat,
            villain_seat: ctx.vsSeat,
            resolved_at: now,
          })
          .eq("trainer_id", trainerId)
          .eq("node_id", row.node_id)
          .eq("user_id", user.id);
      }
      const fit = compatibility(ctx, trainer);
      if (!fit.ok) {
        skipped.push({ nodeId: row.node_id, reason: fit.reason });
        continue;
      }
      const weights = strategies.get(row.node_id);
      if (!weights || !hasRange(weights)) {
        skipped.push({ nodeId: row.node_id, reason: "No strategy" });
        continue;
      }
      const strategy = asStrategy(path[path.length - 1]);
      drill.push({
        nodeId: row.node_id,
        spotId: row.spot_id,
        spotName: spotNames.get(row.spot_id) ?? "Spot",
        label: strategy.label ?? null,
        weight: Number(row.weight) || 1,
        context: ctx,
        actions: strategy.actions,
        weights,
      });
    }

    if (drill.length === 0) {
      return { ok: false, error: `No node can be trained right now: ${skipped[0]?.reason ?? "empty"}.` };
    }

    const { data, error } = await supabase
      .from("poker_trainer_sessions")
      .insert({ user_id: user.id, trainer_id: trainerId })
      .select("id")
      .single();
    if (error) throw error;

    return { ok: true, sessionId: data.id as string, drill, skipped, updated };
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
