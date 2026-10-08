"use server";

import { refresh } from "next/cache";
import { requireUser, fail, type ActionResult } from "@/server/auth";
import { ensureWeek } from "@/server/weeks";
import { queuePush } from "@/server/push";
import {
  addTaskToBlock as addTaskToBlockRow,
  attachTask as attachTaskRow,
  createDrawnBlock,
  detachTask as detachTaskRow,
  moveBlock,
  patchBlock,
  placeTask as placeTaskRow,
  placeTemplate,
  removeBlock,
  setBlockTaskMinutes,
} from "@/server/agenda/schedule";

// Thin wrappers: the rules live in server/agenda/schedule.ts, shared with the
// Claude connector where it is allowed to act.

type PlacedResult = { ok: true; id: string } | { ok: false; error: string };

/** Drop a backlog task onto the grid. */
export async function placeTask(input: {
  weekStart: string;
  taskId: string;
  startsAt: string;
  minutes: number;
}): Promise<PlacedResult> {
  try {
    const { supabase, user } = await requireUser();
    const id = await placeTaskRow(supabase, user.id, input);
    await queuePush(supabase);
    refresh();
    return { ok: true, id };
  } catch (e) {
    return fail(e) as PlacedResult;
  }
}

/** Drop a reusable block onto the grid. */
export async function placeBlock(input: {
  weekStart: string;
  blockId: string;
  startsAt: string;
}): Promise<PlacedResult> {
  try {
    const { supabase, user } = await requireUser();
    const id = await placeTemplate(supabase, user.id, input);
    await queuePush(supabase);
    refresh();
    return { ok: true, id };
  } catch (e) {
    return fail(e) as PlacedResult;
  }
}

/** Create a block from a timeframe drawn on the grid. */
export async function createScheduledBlock(input: {
  weekStart: string;
  categoryId: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
}): Promise<PlacedResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await createDrawnBlock(supabase, user.id, input);
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true, id: r.value };
  } catch (e) {
    return fail(e) as PlacedResult;
  }
}

/**
 * Move or resize: both are just a new start/end pair.
 *
 * Deliberately does not refresh. The grid already holds the new geometry — it
 * is where the drag came from — so re-rendering the route would recompute the
 * whole week only to hand back the position the client just drew. This is the
 * hot path: every drag and every resize goes through here.
 */
export async function moveScheduled(input: {
  id: string;
  startsAt: string;
  endsAt: string;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await moveBlock(supabase, user.id, input);
    if (!r.ok) return r;
    await queuePush(supabase);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function updateScheduled(input: {
  id: string;
  description?: string | null;
  status?: "planned" | "done" | "skipped";
  actualMinutes?: number | null;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await patchBlock(supabase, user.id, input);
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteScheduled(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await removeBlock(supabase, user.id, id);
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Work a backlog task inside an existing block. */
export async function attachTask(input: {
  scheduledBlockId: string;
  taskId: string;
  plannedMinutes: number;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    await attachTaskRow(supabase, user.id, input);
    await queuePush(supabase);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Add a new task directly inside a block. */
export async function addTaskToBlock(input: {
  scheduledBlockId: string;
  categoryId: string;
  description: string | null;
  minutes: number;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await addTaskToBlockRow(supabase, user.id, input);
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Change how much of a block a task claims — and so what the week counts. */
export async function updateBlockTask(input: {
  scheduledBlockId: string;
  taskId: string;
  plannedMinutes: number;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await setBlockTaskMinutes(supabase, user.id, input);
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function detachTask(input: {
  scheduledBlockId: string;
  taskId: string;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await detachTaskRow(supabase, user.id, input);
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ------------------------------------------------------------ week intent

export async function updateWeekMeta(input: {
  weekStart: string;
  theme?: string | null;
  guidelines?: string | null;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const week = await ensureWeek(supabase, user.id, input.weekStart);

    const patch: Record<string, unknown> = {};
    if (input.theme !== undefined) patch.theme = input.theme;
    if (input.guidelines !== undefined) patch.guidelines = input.guidelines;

    const { error } = await supabase
      .from("weeks")
      .update(patch)
      .eq("id", week.id)
      .eq("user_id", user.id);
    if (error) throw error;

    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function createObjective(input: {
  weekStart: string;
  title: string;
  categoryId: string | null;
  targetMinutes: number | null;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const week = await ensureWeek(supabase, user.id, input.weekStart);
    const title = input.title.trim();
    if (!title) return { ok: false, error: "Title is required" };

    const { data: last } = await supabase
      .from("objectives")
      .select("position")
      .eq("week_id", week.id)
      .order("position", { ascending: false })
      .limit(1);

    const { error } = await supabase.from("objectives").insert({
      user_id: user.id,
      week_id: week.id,
      title,
      category_id: input.categoryId,
      target_minutes: input.targetMinutes,
      position: (last?.[0]?.position ?? -1) + 1,
    });
    if (error) throw error;

    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function updateObjective(input: {
  id: string;
  done?: boolean;
  title?: string;
  targetMinutes?: number | null;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const patch: Record<string, unknown> = {};
    if (input.done !== undefined) patch.done = input.done;
    if (input.title !== undefined) patch.title = input.title.trim();
    if (input.targetMinutes !== undefined)
      patch.target_minutes = input.targetMinutes;

    const { error } = await supabase
      .from("objectives")
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

export async function deleteObjective(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const { error } = await supabase
      .from("objectives")
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
