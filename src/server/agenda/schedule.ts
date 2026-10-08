import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureWeek, syncTaskStatus } from "@/server/weeks";
import { resizedChildMinutes } from "@/lib/blocks";
import type { Result } from "@/server/agenda/tasks";

/**
 * The week grid's writes, shared by the planner's server actions and the
 * Claude connector — on the model of server/agenda/tasks.ts. Every function
 * takes the client to act through (cookie-bound for the UI, bearer-token for
 * Claude); both run as the user under RLS, so the rules of migration 0019
 * (a connected app changes only the blocks it created) apply to the connector
 * without anything here having to know.
 *
 * Throws on database errors; returns `{ ok: false }` for anything the caller
 * should show as a sentence. Nothing here refreshes a page or nudges the
 * Google push: the caller decides.
 */

export type NewChild = {
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
export async function insertAdHocTasks(
  db: SupabaseClient,
  userId: string,
  scheduledBlockId: string,
  children: NewChild[],
  positionOffset = 0,
): Promise<string[]> {
  const wanted = children.filter((c) => c.categoryId && c.minutes > 0);
  if (wanted.length === 0) return [];

  const { data: created, error: taskError } = await db
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

  const { error: linkError } = await db.from("scheduled_block_tasks").insert(
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
 * block has nothing left to be once it is out of one. Returns the others,
 * whose status the caller must recompute.
 */
export async function dropAdHocTasks(
  db: SupabaseClient,
  userId: string,
  taskIds: string[],
): Promise<string[]> {
  const ids = [...new Set(taskIds)].filter(Boolean);
  if (ids.length === 0) return [];

  const { data: adHoc } = await db
    .from("tasks")
    .select("id")
    .eq("user_id", userId)
    .eq("ad_hoc", true)
    .in("id", ids);

  const doomed = (adHoc ?? []).map((t) => t.id as string);
  if (doomed.length > 0) {
    await db.from("tasks").delete().eq("user_id", userId).in("id", doomed);
  }
  return ids.filter((id) => !doomed.includes(id));
}

/** Next free position at the bottom of a block. */
async function nextPosition(db: SupabaseClient, userId: string, blockId: string): Promise<number> {
  const { data: last } = await db
    .from("scheduled_block_tasks")
    .select("position")
    .eq("user_id", userId)
    .eq("scheduled_block_id", blockId)
    .order("position", { ascending: false })
    .limit(1);
  return (last?.[0]?.position ?? -1) + 1;
}

/** An empty block on the grid, in the week `weekStart` (created if needed). */
export async function insertBlock(
  db: SupabaseClient,
  userId: string,
  input: { weekStart: string; startsAt: Date; endsAt: Date; description: string | null; sourceBlockId?: string | null },
): Promise<string> {
  const week = await ensureWeek(db, userId, input.weekStart);
  const { data, error } = await db
    .from("scheduled_blocks")
    .insert({
      user_id: userId,
      week_id: week.id,
      starts_at: input.startsAt.toISOString(),
      ends_at: input.endsAt.toISOString(),
      description: input.description?.trim() || null,
      source_block_id: input.sourceBlockId ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

/**
 * Drop a backlog task onto the grid: a block holding just that task.
 *
 * The block itself carries no category and no description: the task inside it
 * is what says what this hour counts as.
 */
export async function placeTask(
  db: SupabaseClient,
  userId: string,
  input: { weekStart: string; taskId: string; startsAt: string; minutes: number },
): Promise<string> {
  const { data: task, error: taskError } = await db
    .from("tasks")
    .select("id")
    .eq("id", input.taskId)
    .eq("user_id", userId)
    .single();
  if (taskError) throw taskError;

  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(startsAt.getTime() + input.minutes * 60_000);
  const blockId = await insertBlock(db, userId, { weekStart: input.weekStart, startsAt, endsAt, description: null });

  const { error: linkError } = await db.from("scheduled_block_tasks").insert({
    user_id: userId,
    scheduled_block_id: blockId,
    task_id: task.id,
    planned_minutes: input.minutes,
    position: 0,
  });
  if (linkError) throw linkError;

  await syncTaskStatus(db, userId, [task.id]);
  return blockId;
}

/**
 * Drop a reusable block onto the grid.
 *
 * A bundle lands as one scheduled block sized to the sum of its items, not as
 * one block per item — so it stays a single thing you can move and resize. Each
 * item becomes a task inside it, which is what gives the block its categories:
 * the item's own, or the template's default when the item has none.
 */
export async function placeTemplate(
  db: SupabaseClient,
  userId: string,
  input: { weekStart: string; blockId: string; startsAt: string },
): Promise<string> {
  const { data: block, error: blockError } = await db
    .from("blocks")
    .select("id, default_minutes, default_category_id, block_items(position, label, estimated_minutes, category_id)")
    .eq("id", input.blockId)
    .eq("user_id", userId)
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
  // No description: a placed template is labelled by its own name, which is
  // resolved from source_block_id when rendering.
  const createdId = await insertBlock(db, userId, {
    weekStart: input.weekStart,
    startsAt,
    endsAt,
    description: null,
    sourceBlockId: block.id,
  });

  // A template with no steps still has to account for its time, so it lands
  // as a single task of the default category covering the whole block.
  const steps: NewChild[] =
    items.length > 0
      ? [...items]
          .sort((a, b) => a.position - b.position)
          .map((i) => ({
            categoryId: i.category_id ?? block.default_category_id,
            description: i.label,
            minutes: i.estimated_minutes,
          }))
      : [{ categoryId: block.default_category_id, description: null, minutes }];

  await insertAdHocTasks(db, userId, createdId, steps);
  return createdId;
}

/**
 * A block from a timeframe, around one new task of `categoryId`. The category
 * belongs to the task, not to the block: a block has none.
 */
export async function createDrawnBlock(
  db: SupabaseClient,
  userId: string,
  input: { weekStart: string; categoryId: string; description: string | null; startsAt: string; endsAt: string },
): Promise<Result<string>> {
  if (!input.categoryId) return { ok: false, error: "Pick a category" };
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  if (endsAt <= startsAt) return { ok: false, error: "End must be after start" };
  const minutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);

  const id = await insertBlock(db, userId, {
    weekStart: input.weekStart,
    startsAt,
    endsAt,
    description: input.description,
  });
  await insertAdHocTasks(db, userId, id, [
    { categoryId: input.categoryId, description: input.description?.trim() || null, minutes },
  ]);
  return { ok: true, value: id };
}

/**
 * Move or resize: both are just a new start/end pair. A single task that
 * filled its block follows the resize (see resizedChildMinutes).
 */
export async function moveBlock(
  db: SupabaseClient,
  userId: string,
  input: { id: string; startsAt: string; endsAt: string },
): Promise<Result> {
  const starts = new Date(input.startsAt);
  const ends = new Date(input.endsAt);
  if (ends <= starts) return { ok: false, error: "End must be after start" };

  // Read the span and the tasks before writing: a resize carries a single
  // task along with the block, and that rule needs the old span.
  const { data: before, error: readError } = await db
    .from("scheduled_blocks")
    .select("starts_at, ends_at, scheduled_block_tasks(task_id, planned_minutes, position)")
    .eq("id", input.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) throw readError;
  if (!before) return { ok: false, error: "Block not found" };

  const { error, count } = await db
    .from("scheduled_blocks")
    .update({ starts_at: starts.toISOString(), ends_at: ends.toISOString(), sync_state: "pending" }, { count: "exact" })
    .eq("id", input.id)
    .eq("user_id", userId);
  if (error) throw error;
  if (!count) return { ok: false, error: "This block cannot be changed from here." };

  const links = [...(before.scheduled_block_tasks ?? [])].sort(
    (a, b) => a.position - b.position || a.task_id.localeCompare(b.task_id),
  );
  const fromMinutes = Math.round(
    (new Date(before.ends_at).getTime() - new Date(before.starts_at).getTime()) / 60_000,
  );
  const toMinutes = Math.round((ends.getTime() - starts.getTime()) / 60_000);
  const resized = resizedChildMinutes(
    links.map((l) => l.planned_minutes),
    fromMinutes,
    toMinutes,
  );
  for (const [i, link] of links.entries()) {
    if (resized[i] === link.planned_minutes) continue;
    const { error: linkError } = await db
      .from("scheduled_block_tasks")
      .update({ planned_minutes: resized[i] })
      .eq("user_id", userId)
      .eq("scheduled_block_id", input.id)
      .eq("task_id", link.task_id);
    if (linkError) throw linkError;
  }
  return { ok: true };
}

export async function patchBlock(
  db: SupabaseClient,
  userId: string,
  input: { id: string; description?: string | null; status?: "planned" | "done" | "skipped"; actualMinutes?: number | null },
): Promise<Result> {
  const patch: Record<string, unknown> = {};
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.status !== undefined) patch.status = input.status;
  if (input.actualMinutes !== undefined) patch.actual_minutes = input.actualMinutes;
  if (Object.keys(patch).length === 0) return { ok: true };

  const { data: updated, error } = await db
    .from("scheduled_blocks")
    .update(patch)
    .eq("id", input.id)
    .eq("user_id", userId)
    .select("scheduled_block_tasks(task_id)")
    .maybeSingle();
  if (error) throw error;
  if (!updated) return { ok: false, error: "This block cannot be changed from here." };

  // Skipping a block (or un-skipping it) changes whether its tasks are still
  // placed: a skipped block's tasks go back to the backlog rail.
  if (input.status !== undefined) {
    await syncTaskStatus(
      db,
      userId,
      (updated.scheduled_block_tasks ?? []).map((l) => l.task_id as string),
    );
  }
  return { ok: true };
}

export async function removeBlock(db: SupabaseClient, userId: string, id: string): Promise<Result> {
  // Read the links first: after the cascade there is nothing left to
  // recompute task status from, nor to tell the ad-hoc tasks apart.
  const { data: links } = await db
    .from("scheduled_block_tasks")
    .select("task_id")
    .eq("user_id", userId)
    .eq("scheduled_block_id", id);

  const { error, count } = await db
    .from("scheduled_blocks")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
  // Nothing deleted: already gone (a double tap — fine), or a block RLS keeps
  // this caller from deleting. Either way its tasks must not be touched.
  if (!count) {
    return links?.length ? { ok: false, error: "This block cannot be deleted from here." } : { ok: true };
  }

  const survivors = await dropAdHocTasks(
    db,
    userId,
    (links ?? []).map((l) => l.task_id as string),
  );
  await syncTaskStatus(db, userId, survivors);
  return { ok: true };
}

/** Work a backlog task inside an existing block (or change how long, if it is there). */
export async function attachTask(
  db: SupabaseClient,
  userId: string,
  input: { scheduledBlockId: string; taskId: string; plannedMinutes: number },
): Promise<void> {
  const position = await nextPosition(db, userId, input.scheduledBlockId);
  const { error } = await db.from("scheduled_block_tasks").upsert({
    user_id: userId,
    scheduled_block_id: input.scheduledBlockId,
    task_id: input.taskId,
    planned_minutes: input.plannedMinutes,
    position,
  });
  if (error) throw error;
  await syncTaskStatus(db, userId, [input.taskId]);
}

/**
 * Add a new task directly inside a block.
 *
 * This is how a block gets its second category without a trip through the
 * backlog — the block is a container, and this is what fills it.
 */
export async function addTaskToBlock(
  db: SupabaseClient,
  userId: string,
  input: { scheduledBlockId: string; categoryId: string; description: string | null; minutes: number },
): Promise<Result> {
  if (!input.categoryId) return { ok: false, error: "Pick a category" };
  if (!(input.minutes > 0)) return { ok: false, error: "Give it a duration" };

  // Ownership is enforced by RLS on the insert below, but reading the block
  // first turns a silent no-op into a message.
  const { data: block, error: blockError } = await db
    .from("scheduled_blocks")
    .select("id")
    .eq("id", input.scheduledBlockId)
    .eq("user_id", userId)
    .maybeSingle();
  if (blockError) throw blockError;
  if (!block) return { ok: false, error: "Block not found" };

  const position = await nextPosition(db, userId, block.id);
  await insertAdHocTasks(
    db,
    userId,
    block.id,
    [{ categoryId: input.categoryId, description: input.description, minutes: input.minutes }],
    position,
  );
  return { ok: true };
}

/** Change how much of a block a task claims — and so what the week counts. */
export async function setBlockTaskMinutes(
  db: SupabaseClient,
  userId: string,
  input: { scheduledBlockId: string; taskId: string; plannedMinutes: number },
): Promise<Result> {
  if (!(input.plannedMinutes > 0)) return { ok: false, error: "Give it a duration" };
  const { error } = await db
    .from("scheduled_block_tasks")
    .update({ planned_minutes: input.plannedMinutes })
    .eq("user_id", userId)
    .eq("scheduled_block_id", input.scheduledBlockId)
    .eq("task_id", input.taskId);
  if (error) throw error;
  return { ok: true };
}

/** Take a task out of a block: a backlog task goes back to the rail, an ad-hoc one goes away. */
export async function detachTask(
  db: SupabaseClient,
  userId: string,
  input: { scheduledBlockId: string; taskId: string },
): Promise<Result> {
  const { error, count } = await db
    .from("scheduled_block_tasks")
    .delete({ count: "exact" })
    .eq("user_id", userId)
    .eq("scheduled_block_id", input.scheduledBlockId)
    .eq("task_id", input.taskId);
  if (error) throw error;
  // Nothing removed: already out, or not this caller's block to change. The
  // task stays as it is either way.
  if (!count) return { ok: true };

  const survivors = await dropAdHocTasks(db, userId, [input.taskId]);
  await syncTaskStatus(db, userId, survivors);
  return { ok: true };
}
