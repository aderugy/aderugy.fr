"use server";

import { refresh } from "next/cache";
import { requireUser, fail, type ActionResult } from "@/server/auth";
import {
  asSetup,
  NODE_TYPES,
  type NodeData,
  type NodeType,
  type SpotSetup,
  type StrategyStats,
  type StrategyWeights,
} from "@/lib/solver/types";

/** Like ActionResult but hands the new row's id back to the client. */
type CreatedResult = { ok: true; id: string } | { ok: false; error: string };

/* -------------------------------------------------------------------- spots */

export async function createSpot(input: {
  name: string;
  description?: string | null;
}): Promise<CreatedResult> {
  try {
    const { supabase, user } = await requireUser();
    const name = input.name.trim();
    if (!name) return { ok: false, error: "Name is required" };

    const { data, error } = await supabase
      .from("poker_spots")
      .insert({
        user_id: user.id,
        name,
        description: input.description?.trim() || null,
      })
      .select("id")
      .single();
    if (error) throw error;

    refresh();
    return { ok: true, id: data.id as string };
  } catch (e) {
    return fail(e) as CreatedResult;
  }
}

export async function updateSpot(input: {
  id: string;
  name?: string;
  description?: string | null;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) return { ok: false, error: "Name is required" };
      patch.name = name;
    }
    if (input.description !== undefined) {
      patch.description = input.description?.trim() || null;
    }

    const { error } = await supabase
      .from("poker_spots")
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

/**
 * The root of the spot's tree: who plays, where it starts, pot and stacks,
 * and the root's notes. Normalised through `asSetup`, so a bad value can't be
 * stored.
 */
export async function updateSpotSetup(input: { id: string; setup: SpotSetup }): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const setup = asSetup(input.setup);
    const { error } = await supabase
      .from("poker_spots")
      .update({ setup })
      .eq("id", input.id)
      .eq("user_id", user.id);
    if (error) throw error;
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteSpot(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const { error } = await supabase
      .from("poker_spots")
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

export async function createNode(input: {
  spotId: string;
  parentId: string | null;
  type: NodeType;
  data: NodeData;
}): Promise<CreatedResult> {
  try {
    const { supabase, user } = await requireUser();
    if (!NODE_TYPES.includes(input.type)) {
      return { ok: false, error: "Unknown node type" };
    }

    // Append after the last sibling under the same parent.
    let siblings = supabase
      .from("poker_nodes")
      .select("position")
      .eq("user_id", user.id)
      .eq("spot_id", input.spotId)
      .order("position", { ascending: false })
      .limit(1);
    siblings = input.parentId
      ? siblings.eq("parent_id", input.parentId)
      : siblings.is("parent_id", null);
    const { data: last, error: lastError } = await siblings;
    if (lastError) throw lastError;
    const position = (last?.[0]?.position ?? -1) + 1;

    const { data, error } = await supabase
      .from("poker_nodes")
      .insert({
        user_id: user.id,
        spot_id: input.spotId,
        parent_id: input.parentId,
        type: input.type,
        position,
        data: input.data,
      })
      .select("id")
      .single();
    if (error) throw error;

    // The spot page keeps its own optimistic copy, so no refresh() here.
    return { ok: true, id: data.id as string };
  } catch (e) {
    return fail(e) as CreatedResult;
  }
}

export async function updateNode(input: {
  id: string;
  data?: NodeData;
  position?: number;
  parentId?: string | null;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const patch: Record<string, unknown> = {};
    if (input.data !== undefined) patch.data = input.data;
    if (input.position !== undefined) patch.position = input.position;
    if (input.parentId !== undefined) patch.parent_id = input.parentId;

    const { error } = await supabase
      .from("poker_nodes")
      .update(patch)
      .eq("id", input.id)
      .eq("user_id", user.id);
    if (error) throw error;

    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteNode(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    // Children (and any strategy rows) fall away through on-delete-cascade.
    const { error } = await supabase
      .from("poker_nodes")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) throw error;

    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/* --------------------------------------------------------------- strategies */

export type SaveStrategyResult = { ok: true; warning?: string } | { ok: false; error: string };

/**
 * Save a decision's grid. `stats` (solver equity / EV, see StrategyStats) is
 * written when given — null clears it, for a grid that no longer comes from
 * the solver — and left as it is when omitted.
 */
export async function saveStrategy(input: {
  nodeId: string;
  weights: StrategyWeights;
  stats?: StrategyStats | null;
}): Promise<SaveStrategyResult> {
  try {
    const { supabase, user } = await requireUser();
    const row: Record<string, unknown> = { node_id: input.nodeId, user_id: user.id, weights: input.weights };
    if (input.stats !== undefined) row.stats = input.stats;
    const upsert = () => supabase.from("poker_strategies").upsert(row, { onConflict: "node_id" });
    let { error } = await upsert();
    // Before migration 0014 the column doesn't exist: keep the grid anyway.
    if (error && "stats" in row && /stats/.test(error.message ?? "")) {
      delete row.stats;
      ({ error } = await upsert());
      if (!error) {
        return {
          ok: true,
          warning: "Equity and EV were not saved: apply supabase/migrations/0014_poker_strategy_stats.sql.",
        };
      }
    }
    if (error) throw error;

    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
