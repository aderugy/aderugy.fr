"use server";

import { refresh } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser, fail, type ActionResult } from "@/server/auth";
import { ensureWeek, syncTaskStatus } from "@/server/weeks";
import { queuePush } from "@/server/push";

type PlacedResult = { ok: true; id: string } | { ok: false; error: string };

type NewChild = {
  categoryId: string;
  description: string | null;
  minutes: number;
};

/**
 * Create tasks that exist only inside a block and link them to it.
 *
 * These are instances, not backlog items: they are born scheduled, marked
 * `ad_hoc`, and deleted with the block. Without that flag, removing a block
 * drawn on the grid would push its task into the backlog as work still to do.
 */
async function insertAdHocTasks(
  supabase: SupabaseClient,
  userId: string,
  scheduledBlockId: string,
  children: NewChild[],
  positionOffset = 0,
): Promise<string[]> {
  const wanted = children.filter((c) => c.categoryId && c.minutes > 0);
  if (wanted.length === 0) return [];

  const { data: created, error: taskError } = await supabase
    .from("tasks")
    .insert(
      wanted.map((c) => ({
        user_id: userId,
        category_id: c.categoryId,
        description: c.description?.trim() || null,
        estimated_minutes: c.minutes,
        priority: 3,
        status: "scheduled",
        ad_hoc: true,
      })),
    )
    .select("id");
  if (taskError) throw taskError;

  const ids = (created ?? []).map((t) => t.id as string);

  const { error: linkError } = await supabase.from("scheduled_block_tasks").insert(
    ids.map((id, i) => ({
      user_id: userId,
      scheduled_block_id: scheduledBlockId,
      task_id: id,
      planned_minutes: wanted[i].minutes,
      position: positionOffset + i,
    })),
  );
  if (linkError) throw linkError;

  return ids;
}

/**
 * Delete the ad-hoc tasks among a set, leaving real backlog tasks alone.
 *
 * Called wherever a link disappears: a task that only ever existed to fill a
 * block has nothing left to be once it is out of one.
 */
async function dropAdHocTasks(
  supabase: SupabaseClient,
  userId: string,
  taskIds: string[],
): Promise<string[]> {
  const ids = [...new Set(taskIds)].filter(Boolean);
  if (ids.length === 0) return [];

  const { data: adHoc } = await supabase
    .from("tasks")
    .select("id")
    .eq("user_id", userId)
    .eq("ad_hoc", true)
    .in("id", ids);

  const doomed = (adHoc ?? []).map((t) => t.id as string);
  if (doomed.length > 0) {
    await supabase.from("tasks").delete().eq("user_id", userId).in("id", doomed);
  }

  // What is left is the caller's problem: real tasks whose status must be
  // recomputed now that one of their links is gone.
  return ids.filter((id) => !doomed.includes(id));
}

/**
 * Drop a backlog task onto the grid.
 *
 * The block itself carries no category and no description: the task inside it
 * is what says what this hour counts as.
 */
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
      .select("id")
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
        description: null,
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
        position: 0,
      });
    if (linkError) throw linkError;

    await syncTaskStatus(supabase, user.id, [task.id]);
    await queuePush(supabase);
    refresh();
    return { ok: true, id: block.id };
  } catch (e) {
    return fail(e) as PlacedResult;
  }
}

/**
 * Drop a reusable block onto the grid.
 *
 * A bundle lands as one scheduled block sized to the sum of its items, not as
 * one block per item — so it stays a single thing you can move and resize. Each
 * item becomes a task inside it, which is what gives the block its categories:
 * the item's own, or the template's default when the item has none.
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
      .select(
        "id, default_minutes, default_category_id, block_items(position, label, estimated_minutes, category_id)",
      )
      .eq("id", input.blockId)
      .eq("user_id", user.id)
      .single();
    if (blockError) throw blockError;

    const items = (block.block_items ?? []) as {
      position: number;
      label: string;
      estimated_minutes: number;
      category_id: string | null;
    }[];
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
        source_block_id: block.id,
      })
      .select("id")
      .single();
    if (error) throw error;

    // A template with no steps still has to account for its time, so it lands
    // as a single task of the default category covering the whole block.
    const steps =
      items.length > 0
        ? [...items]
            .sort((a, b) => a.position - b.position)
            .map((i) => ({
              categoryId: i.category_id ?? block.default_category_id,
              description: i.label,
              minutes: i.estimated_minutes,
            }))
        : [
            {
              categoryId: block.default_category_id,
              description: null as string | null,
              minutes,
            },
          ];

    await insertAdHocTasks(supabase, user.id, created.id, steps);

    await queuePush(supabase);
    refresh();
    return { ok: true, id: created.id };
  } catch (e) {
    return fail(e) as PlacedResult;
  }
}

/**
 * Create a block from a timeframe drawn on the grid.
 *
 * Both ends come from the drag, so unlike the task and template paths there is
 * no implied duration to derive. The category picked in the popup belongs to
 * the task the block is created around, not to the block: a block has none.
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

    const minutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);

    const { data, error } = await supabase
      .from("scheduled_blocks")
      .insert({
        user_id: user.id,
        week_id: week.id,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        description: input.description?.trim() || null,
      })
      .select("id")
      .single();
    if (error) throw error;

    await insertAdHocTasks(supabase, user.id, data.id, [
      {
        categoryId: input.categoryId,
        description: input.description?.trim() || null,
        minutes,
      },
    ]);

    await queuePush(supabase);
    refresh();
    return { ok: true, id: data.id };
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
    const patch: Record<string, unknown> = {};
    if (input.description !== undefined) {
      patch.description = input.description?.trim() || null;
    }
    if (input.status !== undefined) patch.status = input.status;
    if (input.actualMinutes !== undefined) patch.actual_minutes = input.actualMinutes;

    const { error } = await supabase
      .from("scheduled_blocks")
      .update(patch)
      .eq("id", input.id)
      .eq("user_id", user.id);
    if (error) throw error;

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

    // Read the links first: after the cascade there is nothing left to
    // recompute task status from, nor to tell the ad-hoc tasks apart.
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

    const survivors = await dropAdHocTasks(
      supabase,
      user.id,
      (links ?? []).map((l) => l.task_id as string),
    );
    await syncTaskStatus(supabase, user.id, survivors);
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

    const { data: last } = await supabase
      .from("scheduled_block_tasks")
      .select("position")
      .eq("user_id", user.id)
      .eq("scheduled_block_id", input.scheduledBlockId)
      .order("position", { ascending: false })
      .limit(1);

    const { error } = await supabase.from("scheduled_block_tasks").upsert({
      user_id: user.id,
      scheduled_block_id: input.scheduledBlockId,
      task_id: input.taskId,
      planned_minutes: input.plannedMinutes,
      position: (last?.[0]?.position ?? -1) + 1,
    });
    if (error) throw error;

    await syncTaskStatus(supabase, user.id, [input.taskId]);
    await queuePush(supabase);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Add a new task directly inside a block.
 *
 * This is how a block gets its second category without a trip through the
 * backlog — the block is a container, and this is what fills it.
 */
export async function addTaskToBlock(input: {
  scheduledBlockId: string;
  categoryId: string;
  description: string | null;
  minutes: number;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    if (!input.categoryId) return { ok: false, error: "Pick a category" };
    if (!(input.minutes > 0)) return { ok: false, error: "Give it a duration" };

    // Ownership is enforced by RLS on the insert below, but reading the block
    // first turns a silent no-op into a message.
    const { data: block, error: blockError } = await supabase
      .from("scheduled_blocks")
      .select("id")
      .eq("id", input.scheduledBlockId)
      .eq("user_id", user.id)
      .single();
    if (blockError) throw blockError;

    const { data: last } = await supabase
      .from("scheduled_block_tasks")
      .select("position")
      .eq("user_id", user.id)
      .eq("scheduled_block_id", block.id)
      .order("position", { ascending: false })
      .limit(1);

    await insertAdHocTasks(
      supabase,
      user.id,
      block.id,
      [
        {
          categoryId: input.categoryId,
          description: input.description,
          minutes: input.minutes,
        },
      ],
      (last?.[0]?.position ?? -1) + 1,
    );

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
    if (!(input.plannedMinutes > 0)) {
      return { ok: false, error: "Give it a duration" };
    }

    const { error } = await supabase
      .from("scheduled_block_tasks")
      .update({ planned_minutes: input.plannedMinutes })
      .eq("user_id", user.id)
      .eq("scheduled_block_id", input.scheduledBlockId)
      .eq("task_id", input.taskId);
    if (error) throw error;

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
    const { error } = await supabase
      .from("scheduled_block_tasks")
      .delete()
      .eq("user_id", user.id)
      .eq("scheduled_block_id", input.scheduledBlockId)
      .eq("task_id", input.taskId);
    if (error) throw error;

    // A backlog task goes back to the rail; one that only existed to fill this
    // block goes away with it.
    const survivors = await dropAdHocTasks(supabase, user.id, [input.taskId]);
    await syncTaskStatus(supabase, user.id, survivors);
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
