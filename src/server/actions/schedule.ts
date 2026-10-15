"use server";

import { refresh } from "next/cache";
import { requireUser, fail, type ActionResult } from "@/server/auth";
import { ensureWeek } from "@/server/weeks";
import { queuePush } from "@/server/push";
import {
  createTaskAt,
  deleteSession,
  moveSession,
  placeTask as placeTaskRow,
  reschedule as rescheduleRow,
  sendToBacklog,
  setSessionStatus,
} from "@/server/agenda/schedule";
import type { SessionStatus } from "@/lib/types";

// Thin wrappers: the rules live in server/agenda/schedule.ts, shared with the
// Claude connector where it is allowed to act.

type PlacedResult = { ok: true; id: string } | { ok: false; error: string };

/** Put a backlog task on the grid: dropped from the rail, or picked in the draw popup. */
export async function placeTask(input: {
  taskId: string;
  startsAt: string;
  minutes?: number;
  endsAt?: string;
}): Promise<PlacedResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await placeTaskRow(supabase, user.id, input);
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true, id: r.value };
  } catch (e) {
    return fail(e) as PlacedResult;
  }
}

/** A new task straight on the grid, from a range drawn there. */
export async function createTaskOnGrid(input: {
  categoryId: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
}): Promise<PlacedResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await createTaskAt(supabase, user.id, input);
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true, id: r.value.sessionId };
  } catch (e) {
    return fail(e) as PlacedResult;
  }
}

/**
 * Move or resize a slot.
 *
 * A plain move deliberately does not refresh: the grid already holds the new
 * geometry — it is where the drag came from — so re-rendering the route would
 * only hand back the position the client just drew. This is the hot path.
 * A move that turned into a reschedule (a slot already started) does refresh,
 * since there are now two slots where the grid drew one.
 */
export async function moveScheduled(input: {
  id: string;
  startsAt: string;
  endsAt: string;
}): Promise<{ ok: true; id: string; rescheduled: boolean } | { ok: false; error: string }> {
  try {
    const { supabase, user } = await requireUser();
    const r = await moveSession(supabase, user.id, input);
    if (!r.ok) return r;
    await queuePush(supabase);
    if (r.value.rescheduled) refresh();
    return { ok: true, ...r.value };
  } catch (e) {
    return fail(e) as { ok: false; error: string };
  }
}

/** Skip the slot (if planned) and plan the task again at a new time. */
export async function rescheduleSession(input: {
  id: string;
  startsAt: string;
  endsAt: string;
}): Promise<PlacedResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await rescheduleRow(supabase, user.id, {
      id: input.id,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
    });
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true, id: r.value.id };
  } catch (e) {
    return fail(e) as PlacedResult;
  }
}

/** Done, skipped, or back to planned. */
export async function setSlotStatus(input: { id: string; status: SessionStatus }): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await setSessionStatus(supabase, user.id, input);
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Off the grid, back to the backlog: deleted if not started, skipped otherwise. */
export async function slotToBacklog(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await sendToBacklog(supabase, user.id, { id });
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Delete a slot outright, history included. The task stays. */
export async function deleteSlot(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await deleteSession(supabase, user.id, id);
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Every slot a task has had, newest first: the history shown in the session panel. */
export async function taskHistory(
  taskId: string,
): Promise<
  | { ok: true; sessions: { id: string; starts_at: string; ends_at: string; status: SessionStatus; created_by: "app" | "claude" }[] }
  | { ok: false; error: string }
> {
  try {
    const { supabase, user } = await requireUser();
    const { data, error } = await supabase
      .from("task_sessions")
      .select("id, starts_at, ends_at, status, created_by")
      .eq("user_id", user.id)
      .eq("task_id", taskId)
      .order("starts_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return { ok: true, sessions: (data ?? []) as { id: string; starts_at: string; ends_at: string; status: SessionStatus; created_by: "app" | "claude" }[] };
  } catch (e) {
    return fail(e) as { ok: false; error: string };
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
