import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureWeek } from "@/server/weeks";
import { TASK_LIMITS } from "@/lib/agenda/backlog";
import { canUnschedule, moveReschedules } from "@/lib/agenda/sessions";
import { isoWeekStartInTimeZone } from "@/lib/time";
import type { SessionStatus } from "@/lib/types";
import type { Result } from "@/server/agenda/tasks";

/**
 * The week grid's writes, shared by the planner's server actions and the
 * Claude connector — on the model of server/agenda/tasks.ts. Every function
 * takes the client to act through (cookie-bound for the UI, bearer-token for
 * Claude); both run as the user under RLS, so the rules of migration 0025 (a
 * connected app changes only the sessions it created) apply to the connector
 * without anything here having to know.
 *
 * The grid holds sessions: one task, one span of time. A task's status
 * follows its sessions through a trigger, so nothing here recomputes it.
 *
 * Throws on database errors; returns `{ ok: false }` for anything the caller
 * should show as a sentence. Nothing here refreshes a page or nudges the
 * Google push: the caller decides.
 */

const APP_TIMEZONE = process.env.NEXT_PUBLIC_APP_TIMEZONE ?? "Europe/Paris";

const SESSION_READ = "id, task_id, week_id, starts_at, ends_at, status";

type SessionRow = {
  id: string;
  task_id: string;
  week_id: string;
  starts_at: string;
  ends_at: string;
  status: SessionStatus;
};

/** The unique index allowing one planned session per task (0025). */
const ONE_PLANNED = "task_sessions_one_planned_idx";

function isOnePlannedViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  return err?.code === "23505" && (err.message ?? "").includes(ONE_PLANNED);
}

const ALREADY_PLANNED =
  "This task already has a slot on the grid. Move that one, or skip it first.";

function checkSpan(startsAt: Date, endsAt: Date): string | null {
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return "Pick a start and an end.";
  if (endsAt <= startsAt) return "End must be after start";
  const minutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
  if (minutes < 5) return "A slot lasts at least 5 minutes.";
  if (minutes > 24 * 60) return "A slot lasts 24 hours at most.";
  return null;
}

/** The week a time belongs to, created if needed. */
async function weekOf(db: SupabaseClient, userId: string, at: Date): Promise<string> {
  const week = await ensureWeek(db, userId, isoWeekStartInTimeZone(at, APP_TIMEZONE));
  return week.id;
}

async function readSession(db: SupabaseClient, userId: string, id: string): Promise<SessionRow | null> {
  const { data, error } = await db
    .from("task_sessions")
    .select(SESSION_READ)
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as SessionRow | null) ?? null;
}

/** A new session for an existing task. Fails with a sentence if it already has a planned one. */
async function insertSession(
  db: SupabaseClient,
  userId: string,
  input: { taskId: string; startsAt: Date; endsAt: Date },
): Promise<Result<string>> {
  const weekId = await weekOf(db, userId, input.startsAt);
  const { data, error } = await db
    .from("task_sessions")
    .insert({
      user_id: userId,
      task_id: input.taskId,
      week_id: weekId,
      starts_at: input.startsAt.toISOString(),
      ends_at: input.endsAt.toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    if (isOnePlannedViolation(error)) return { ok: false, error: ALREADY_PLANNED };
    throw error;
  }
  return { ok: true, value: data.id as string };
}

/**
 * Put an existing task on the grid: dropped from the rail, picked in the draw
 * popup, or chosen by Claude. The slot is `minutes` long, or ends at `endsAt`.
 */
export async function placeTask(
  db: SupabaseClient,
  userId: string,
  input: { taskId: string; startsAt: string; minutes?: number; endsAt?: string },
): Promise<Result<string>> {
  const { data: task, error } = await db
    .from("tasks")
    .select("id, status")
    .eq("id", input.taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!task) return { ok: false, error: "No such task." };
  if (task.status === "done" || task.status === "dropped") {
    return { ok: false, error: `This task is ${task.status}; reopen it before planning it.` };
  }

  const startsAt = new Date(input.startsAt);
  const endsAt = input.endsAt
    ? new Date(input.endsAt)
    : new Date(startsAt.getTime() + (input.minutes ?? 0) * 60_000);
  const problem = checkSpan(startsAt, endsAt);
  if (problem) return { ok: false, error: problem };

  return insertSession(db, userId, { taskId: task.id as string, startsAt, endsAt });
}

/**
 * A new task straight on the grid, from a range drawn there. It is a task
 * like any other: skipping its slot sends it to the backlog, where it waits
 * to be planned again. Its estimate is the length drawn.
 */
export async function createTaskAt(
  db: SupabaseClient,
  userId: string,
  input: { categoryId: string; description: string | null; notes?: string | null; startsAt: string; endsAt: string; priority?: number },
): Promise<Result<{ sessionId: string; taskId: string }>> {
  if (!input.categoryId) return { ok: false, error: "Pick a category" };
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  const problem = checkSpan(startsAt, endsAt);
  if (problem) return { ok: false, error: problem };
  const minutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);
  const description = input.description?.trim() || null;
  if (description && description.length > TASK_LIMITS.maxDescription) {
    return { ok: false, error: `Description is limited to ${TASK_LIMITS.maxDescription} characters.` };
  }

  const { data: task, error } = await db
    .from("tasks")
    .insert({
      user_id: userId,
      category_id: input.categoryId,
      description,
      notes: input.notes?.trim() || null,
      estimated_minutes: Math.min(Math.max(minutes, TASK_LIMITS.minMinutes), TASK_LIMITS.maxMinutes),
      priority: input.priority ?? 3,
    })
    .select("id")
    .single();
  if (error) throw error;

  try {
    const placed = await insertSession(db, userId, { taskId: task.id as string, startsAt, endsAt });
    if (!placed.ok) throw new Error(placed.error);
    return { ok: true, value: { sessionId: placed.value, taskId: task.id as string } };
  } catch (e) {
    // No task left behind without the slot it was drawn for.
    await db.from("tasks").delete().eq("user_id", userId).eq("id", task.id);
    throw e;
  }
}

/**
 * Move or resize a session: both are a new start/end pair.
 *
 * A slot that has not started is simply moved. One whose start has passed is
 * rescheduled instead (see `moveReschedules`): it stays where it was as
 * skipped, and the task gets a new planned slot — so a missed attempt is never
 * erased by dragging it to tomorrow. A skipped slot does not move at all.
 *
 * Returns the id of the session now planned, which is new after a reschedule.
 */
export async function moveSession(
  db: SupabaseClient,
  userId: string,
  input: { id: string; startsAt: string; endsAt: string; now?: number },
): Promise<Result<{ id: string; rescheduled: boolean }>> {
  const starts = new Date(input.startsAt);
  const ends = new Date(input.endsAt);
  const problem = checkSpan(starts, ends);
  if (problem) return { ok: false, error: problem };

  const session = await readSession(db, userId, input.id);
  if (!session) return { ok: false, error: "This slot no longer exists." };
  if (session.status === "skipped") {
    return { ok: false, error: "A skipped slot stays where it was. Plan the task again instead." };
  }

  const now = input.now ?? Date.now();
  const moved = Date.parse(session.starts_at) !== starts.getTime();
  if (moved && moveReschedules(session, now)) {
    return reschedule(db, userId, { id: session.id, startsAt: starts, endsAt: ends });
  }

  const patch: Record<string, unknown> = {
    starts_at: starts.toISOString(),
    ends_at: ends.toISOString(),
  };
  // Keep the week in step, so the week's totals follow a slot dragged across
  // a Sunday night.
  const newWeek = isoWeekStartInTimeZone(starts, APP_TIMEZONE);
  if (newWeek !== isoWeekStartInTimeZone(new Date(session.starts_at), APP_TIMEZONE)) {
    patch.week_id = await weekOf(db, userId, starts);
  }

  const { error, count } = await db
    .from("task_sessions")
    .update(patch, { count: "exact" })
    .eq("id", session.id)
    .eq("user_id", userId);
  if (error) throw error;
  if (!count) return { ok: false, error: "This slot cannot be changed from here." };
  return { ok: true, value: { id: session.id, rescheduled: false } };
}

/**
 * Skip a slot (if still planned) and plan the task again at a new time, in one
 * transaction (`reschedule_session`). From a skipped or done slot, this only
 * plans the new one: "do it again".
 */
export async function reschedule(
  db: SupabaseClient,
  userId: string,
  input: { id: string; startsAt: Date; endsAt: Date },
): Promise<Result<{ id: string; rescheduled: boolean }>> {
  const problem = checkSpan(input.startsAt, input.endsAt);
  if (problem) return { ok: false, error: problem };
  const weekId = await weekOf(db, userId, input.startsAt);
  const { data, error } = await db.rpc("reschedule_session", {
    p_session_id: input.id,
    p_week_id: weekId,
    p_starts_at: input.startsAt.toISOString(),
    p_ends_at: input.endsAt.toISOString(),
  });
  if (error) {
    if (isOnePlannedViolation(error)) return { ok: false, error: ALREADY_PLANNED };
    if (error.code === "42501" || error.code === "P0002") return { ok: false, error: error.message };
    throw error;
  }
  return { ok: true, value: { id: data as string, rescheduled: true } };
}

/**
 * Mark a slot done, skipped, or planned again (undo).
 *
 * Done marks the task done; skipped sends it back to the backlog, keeping the
 * slot as history. Back to planned is refused when the task already has
 * another planned slot.
 */
export async function setSessionStatus(
  db: SupabaseClient,
  userId: string,
  input: { id: string; status: SessionStatus },
): Promise<Result> {
  const { error, count } = await db
    .from("task_sessions")
    .update({ status: input.status }, { count: "exact" })
    .eq("id", input.id)
    .eq("user_id", userId);
  if (error) {
    if (isOnePlannedViolation(error)) return { ok: false, error: ALREADY_PLANNED };
    throw error;
  }
  if (!count) return { ok: false, error: "This slot cannot be changed from here." };
  return { ok: true };
}

/**
 * Take a task off the grid and back to the backlog.
 *
 * A slot that has not started yet is deleted: nothing happened there. One the
 * clock has reached is skipped instead, so it stays in the task's history.
 */
export async function sendToBacklog(
  db: SupabaseClient,
  userId: string,
  input: { id: string; now?: number },
): Promise<Result<{ deleted: boolean }>> {
  const session = await readSession(db, userId, input.id);
  if (!session) return { ok: true, value: { deleted: true } };
  if (session.status !== "planned") {
    return { ok: false, error: `This slot is ${session.status}; there is nothing to take off the grid.` };
  }
  if (canUnschedule(session, input.now ?? Date.now())) {
    const r = await deleteSession(db, userId, session.id);
    return r.ok ? { ok: true, value: { deleted: true } } : r;
  }
  const r = await setSessionStatus(db, userId, { id: session.id, status: "skipped" });
  return r.ok ? { ok: true, value: { deleted: false } } : r;
}

/** Delete a slot outright. Its Google event goes with it (0025's tombstone trigger). */
export async function deleteSession(db: SupabaseClient, userId: string, id: string): Promise<Result> {
  const { error, count } = await db
    .from("task_sessions")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
  // Nothing deleted: already gone (a double tap — fine), or a slot RLS keeps
  // this caller from deleting.
  if (!count) {
    const still = await readSession(db, userId, id);
    return still ? { ok: false, error: "This slot cannot be deleted from here." } : { ok: true };
  }
  return { ok: true };
}

/**
 * A task finished or abandoned outside the grid (backlog, editor, Claude)
 * closes its live slot too, so the grid does not keep a planned slot for work
 * that is over:
 * - done: a slot already started becomes done; one still to come is deleted;
 * - dropped: a slot already started is skipped; one still to come is deleted.
 * Best effort through the connector, which may not touch Arthur's slots.
 */
export async function closeLiveSession(
  db: SupabaseClient,
  userId: string,
  taskId: string,
  outcome: "done" | "dropped",
  now = Date.now(),
): Promise<void> {
  const { data, error } = await db
    .from("task_sessions")
    .select(SESSION_READ)
    .eq("user_id", userId)
    .eq("task_id", taskId)
    .eq("status", "planned");
  if (error) throw error;
  for (const s of (data ?? []) as SessionRow[]) {
    if (canUnschedule(s, now)) {
      await db.from("task_sessions").delete().eq("user_id", userId).eq("id", s.id);
    } else {
      await db
        .from("task_sessions")
        .update({ status: outcome === "done" ? "done" : "skipped" })
        .eq("user_id", userId)
        .eq("id", s.id);
    }
  }
}
