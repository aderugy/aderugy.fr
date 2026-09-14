"use server";

import { revalidatePath } from "next/cache";
import { requireUser, fail, type ActionResult } from "@/server/auth";
import { ensureWeek, syncTaskStatus } from "@/server/weeks";

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
    const week = await ensureWeek(supabase, user.id, input.weekStart);

    const { data: task, error: taskError } = await supabase
      .from("tasks")
      .select("id, description, category_id")
      .eq("id", input.taskId)
      .eq("user_id", user.id)
      .single();
    if (taskError) throw taskError;

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(startsAt.getTime() + input.minutes * 60_000);

    const { data: block, error } = await supabase
      .from("scheduled_blocks")
      .insert({
        user_id: user.id,
        week_id: week.id,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        description: task.description,
        category_id: task.category_id,
      })
      .select("id")
      .single();
    if (error) throw error;

    const { error: linkError } = await supabase
      .from("scheduled_block_tasks")
      .insert({
        user_id: user.id,
        scheduled_block_id: block.id,
        task_id: task.id,
        planned_minutes: input.minutes,
      });
    if (linkError) throw linkError;

    await syncTaskStatus(supabase, user.id, [task.id]);
    revalidatePath("/agenda", "layout");
    return { ok: true, id: block.id };
  } catch (e) {
    return fail(e) as PlacedResult;
  }
}

/**
 * Drop a reusable block onto the grid.
 *
 * A bundle lands as one scheduled block sized to the sum of its items, not as
 * one block per item — so it stays a single thing you can move and resize.
 */
export async function placeBlock(input: {
  weekStart: string;
  blockId: string;
  startsAt: string;
}): Promise<PlacedResult> {
  try {
    const { supabase, user } = await requireUser();
    const week = await ensureWeek(supabase, user.id, input.weekStart);

    const { data: block, error: blockError } = await supabase
      .from("blocks")
      .select("id, default_minutes, default_category_id, block_items(estimated_minutes)")
      .eq("id", input.blockId)
      .eq("user_id", user.id)
      .single();
    if (blockError) throw blockError;

    const items = (block.block_items ?? []) as { estimated_minutes: number }[];
    const itemMinutes = items.reduce((sum, i) => sum + i.estimated_minutes, 0);
    const minutes = itemMinutes > 0 ? itemMinutes : block.default_minutes;

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(startsAt.getTime() + minutes * 60_000);

    const { data: created, error } = await supabase
      .from("scheduled_blocks")
      .insert({
        user_id: user.id,
        week_id: week.id,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        // No description: a placed template is labelled by its own name, which
        // is resolved from source_block_id when rendering.
        description: null,
        category_id: block.default_category_id,
        source_block_id: block.id,
      })
      .select("id")
      .single();
    if (error) throw error;

    revalidatePath("/agenda", "layout");
    return { ok: true, id: created.id };
  } catch (e) {
    return fail(e) as PlacedResult;
  }
}

/**
 * Create a block from a timeframe drawn on the grid.
 *
 * Both ends come from the drag, so unlike the task and template paths there is
 * no implied duration to derive.
 */
export async function createScheduledBlock(input: {
  weekStart: string;
  categoryId: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
}): Promise<PlacedResult> {
  try {
    const { supabase, user } = await requireUser();
    if (!input.categoryId) return { ok: false, error: "Pick a category" };

    const week = await ensureWeek(supabase, user.id, input.weekStart);

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (endsAt <= startsAt) return { ok: false, error: "End must be after start" };

    const { data, error } = await supabase
      .from("scheduled_blocks")
      .insert({
        user_id: user.id,
        week_id: week.id,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        description: input.description?.trim() || null,
        category_id: input.categoryId,
      })
      .select("id")
      .single();
    if (error) throw error;

    revalidatePath("/agenda", "layout");
    return { ok: true, id: data.id };
  } catch (e) {
    return fail(e) as PlacedResult;
  }
}

/** Move or resize: both are just a new start/end pair. */
export async function moveScheduled(input: {
  id: string;
  startsAt: string;
  endsAt: string;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const starts = new Date(input.startsAt);
    const ends = new Date(input.endsAt);
    if (ends <= starts) return { ok: false, error: "End must be after start" };

    const { error } = await supabase
      .from("scheduled_blocks")
      .update({
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        sync_state: "pending",
      })
      .eq("id", input.id)
      .eq("user_id", user.id);
    if (error) throw error;

    revalidatePath("/agenda", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function updateScheduled(input: {
  id: string;
  description?: string | null;
  categoryId?: string;
  status?: "planned" | "done" | "skipped";
  actualMinutes?: number | null;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const patch: Record<string, unknown> = {};
    if (input.description !== undefined) {
      patch.description = input.description?.trim() || null;
    }
    if (input.categoryId !== undefined) {
      if (!input.categoryId) return { ok: false, error: "Pick a category" };
      patch.category_id = input.categoryId;
    }
    if (input.status !== undefined) patch.status = input.status;
    if (input.actualMinutes !== undefined) patch.actual_minutes = input.actualMinutes;

    const { error } = await supabase
      .from("scheduled_blocks")
      .update(patch)
      .eq("id", input.id)
      .eq("user_id", user.id);
    if (error) throw error;

    revalidatePath("/agenda", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteScheduled(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();

    // Read the links first: after the cascade there is nothing left to
    // recompute task status from.
    const { data: links } = await supabase
      .from("scheduled_block_tasks")
      .select("task_id")
      .eq("user_id", user.id)
      .eq("scheduled_block_id", id);

    const { error } = await supabase
      .from("scheduled_blocks")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) throw error;

    await syncTaskStatus(
      supabase,
      user.id,
      (links ?? []).map((l) => l.task_id as string),
    );
    revalidatePath("/agenda", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Work a second task inside an existing block. */
export async function attachTask(input: {
  scheduledBlockId: string;
  taskId: string;
  plannedMinutes: number;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const { error } = await supabase.from("scheduled_block_tasks").upsert({
      user_id: user.id,
      scheduled_block_id: input.scheduledBlockId,
      task_id: input.taskId,
      planned_minutes: input.plannedMinutes,
    });
    if (error) throw error;

    await syncTaskStatus(supabase, user.id, [input.taskId]);
    revalidatePath("/agenda", "layout");
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
    const { error } = await supabase
      .from("scheduled_block_tasks")
      .delete()
      .eq("user_id", user.id)
      .eq("scheduled_block_id", input.scheduledBlockId)
      .eq("task_id", input.taskId);
    if (error) throw error;

    await syncTaskStatus(supabase, user.id, [input.taskId]);
    revalidatePath("/agenda", "layout");
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

    revalidatePath("/agenda", "layout");
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

    revalidatePath("/agenda", "layout");
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

    revalidatePath("/agenda", "layout");
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

    revalidatePath("/agenda", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
