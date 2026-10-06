import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  TASK_LIMITS,
  compareTasks,
  subtreeOf,
  withInheritedArchive,
  type CategoryPathRow,
} from "@/lib/agenda/backlog";
import type { TaskStatus } from "@/lib/types";
import { livePlacements } from "@/server/weeks";

/**
 * Backlog persistence shared by the UI's server actions and the Claude
 * connector. Every function takes the Supabase client it should act through:
 * the cookie-bound one for the UI, a bearer-token one for the connector. Both
 * run as the signed-in user under RLS — nothing here bypasses it.
 *
 * Throws on database errors; returns `{ ok: false }` for anything the caller
 * should show as a sentence.
 */

export type Result<T = undefined> =
  | (T extends undefined ? { ok: true } : { ok: true; value: T })
  | { ok: false; error: string };

export type NewTask = {
  categoryId: string;
  description: string | null;
  /** Extended description, Markdown. */
  notes?: string | null;
  estimatedMinutes: number;
  priority: number;
  /** ISO timestamp, or null. */
  deadline: string | null;
  splittable?: boolean;
  /** The /jobs application this task belongs to (prep, follow-up…). */
  applicationId?: string | null;
};

export type TaskPatch = {
  categoryId?: string;
  description?: string | null;
  notes?: string | null;
  estimatedMinutes?: number;
  priority?: number;
  deadline?: string | null;
  status?: TaskStatus;
};

export const TASK_COLUMNS =
  "id, category_id, description, notes, estimated_minutes, priority, deadline, status, splittable, ad_hoc, completed_at, created_at";

export type TaskRow = {
  id: string;
  category_id: string;
  description: string | null;
  notes: string | null;
  estimated_minutes: number;
  priority: number;
  deadline: string | null;
  status: TaskStatus;
  splittable: boolean;
  ad_hoc: boolean;
  completed_at: string | null;
  created_at: string;
};

function checkMinutes(n: number): string | null {
  if (!Number.isInteger(n) || n < TASK_LIMITS.minMinutes || n > TASK_LIMITS.maxMinutes) {
    return `Estimate must be a whole number of minutes between ${TASK_LIMITS.minMinutes} and ${TASK_LIMITS.maxMinutes}.`;
  }
  return null;
}

function checkPriority(n: number): string | null {
  return Number.isInteger(n) && n >= 1 && n <= 4
    ? null
    : "Priority must be 1 (urgent), 2 (high), 3 (normal) or 4 (someday).";
}

function cleanDescription(d: string | null | undefined): string | null {
  const t = d?.trim();
  return t ? t : null;
}

/** Notes keep their inner formatting; only surrounding blank space goes. */
function cleanNotes(n: string | null | undefined): string | null {
  const t = n?.replace(/^\s*\n/, "").trimEnd();
  return t ? t : null;
}

function checkNotes(n: string | null): string | null {
  return n && n.length > TASK_LIMITS.maxNotes
    ? `Notes are limited to ${TASK_LIMITS.maxNotes} characters.`
    : null;
}

function checkDescription(d: string | null): string | null {
  return d && d.length > TASK_LIMITS.maxDescription
    ? `Description is limited to ${TASK_LIMITS.maxDescription} characters.`
    : null;
}

/** Validate and insert in one statement, so a batch lands whole or not at all. */
export async function insertTasks(
  db: SupabaseClient,
  userId: string,
  tasks: NewTask[],
): Promise<Result<TaskRow[]>> {
  const rows = [];
  for (const [i, t] of tasks.entries()) {
    const at = tasks.length > 1 ? `Task ${i + 1}: ` : "";
    if (!t.categoryId) return { ok: false, error: `${at}Pick a category` };
    const description = cleanDescription(t.description);
    const notes = cleanNotes(t.notes);
    const problem =
      checkMinutes(t.estimatedMinutes) ??
      checkPriority(t.priority) ??
      checkDescription(description) ??
      checkNotes(notes);
    if (problem) return { ok: false, error: at + problem };
    rows.push({
      user_id: userId,
      category_id: t.categoryId,
      description,
      notes,
      estimated_minutes: t.estimatedMinutes,
      priority: t.priority,
      deadline: t.deadline,
      splittable: t.splittable ?? true,
      // Only sent when set, so creating a task never depends on the column.
      ...(t.applicationId ? { application_id: t.applicationId } : {}),
    });
  }
  if (rows.length === 0) return { ok: true, value: [] };

  const { data, error } = await db.from("tasks").insert(rows).select(TASK_COLUMNS);
  if (error) throw error;
  return { ok: true, value: (data ?? []) as TaskRow[] };
}

export async function patchTask(
  db: SupabaseClient,
  userId: string,
  id: string,
  input: TaskPatch,
): Promise<Result<TaskRow>> {
  const patch: Record<string, unknown> = {};

  if (input.categoryId !== undefined) {
    if (!input.categoryId) return { ok: false, error: "Pick a category" };
    patch.category_id = input.categoryId;
  }
  if (input.description !== undefined) {
    const description = cleanDescription(input.description);
    const problem = checkDescription(description);
    if (problem) return { ok: false, error: problem };
    patch.description = description;
  }
  if (input.notes !== undefined) {
    const notes = cleanNotes(input.notes);
    const problem = checkNotes(notes);
    if (problem) return { ok: false, error: problem };
    patch.notes = notes;
  }
  if (input.estimatedMinutes !== undefined) {
    const problem = checkMinutes(input.estimatedMinutes);
    if (problem) return { ok: false, error: problem };
    patch.estimated_minutes = input.estimatedMinutes;
  }
  if (input.priority !== undefined) {
    const problem = checkPriority(input.priority);
    if (problem) return { ok: false, error: problem };
    patch.priority = input.priority;
  }
  if (input.deadline !== undefined) patch.deadline = input.deadline;
  if (input.status !== undefined) {
    patch.status = input.status;
    patch.completed_at = input.status === "done" ? new Date().toISOString() : null;
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "Nothing to change." };
  }

  const { data, error } = await db
    .from("tasks")
    .update(patch)
    .eq("id", id)
    .eq("user_id", userId)
    .select(TASK_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, error: "No such task." };
  return { ok: true, value: data as TaskRow };
}

export async function removeTask(
  db: SupabaseClient,
  userId: string,
  id: string,
): Promise<Result> {
  const { data, error } = await db
    .from("tasks")
    .delete()
    .eq("id", id)
    .eq("user_id", userId)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) return { ok: false, error: "No such task." };
  return { ok: true };
}

/* ------------------------------------------------------------- reading */

export async function loadCategoryPaths(
  db: SupabaseClient,
  userId: string,
): Promise<CategoryPathRow[]> {
  const { data, error } = await db
    .from("categories_with_path")
    .select("id, parent_id, name, path, archived")
    .eq("user_id", userId)
    .order("path");
  if (error) throw error;
  return withInheritedArchive((data ?? []) as CategoryPathRow[]);
}

/** A task as listed: the row, its category path, and how much of it is on the grid. */
export type ListedTask = TaskRow & {
  category_path: string;
  /** Minutes planned in blocks that are not skipped, across all weeks. */
  placed_minutes: number;
};

export type TaskFilters = {
  /** Restrict to this category and everything under it. */
  categoryId?: string;
  statuses?: TaskStatus[];
  /** Keep tasks at least this urgent: 2 keeps urgent and high. */
  maxPriority?: number;
  /** ISO timestamp: keep tasks whose deadline is on or before it. */
  deadlineBefore?: string;
  /** Case-insensitive match on the description. */
  query?: string;
  limit?: number;
};

/** Escape PostgREST/LIKE wildcards so a query is matched literally. */
function likeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function listTasks(
  db: SupabaseClient,
  userId: string,
  categories: CategoryPathRow[],
  filters: TaskFilters,
): Promise<{ tasks: ListedTask[]; truncated: boolean }> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const statuses = filters.statuses?.length
    ? filters.statuses
    : (["backlog", "scheduled"] as TaskStatus[]);

  let q = db
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("user_id", userId)
    // Tasks drawn inside a block belong to it, not to the backlog — the
    // backlog page hides them for the same reason.
    .eq("ad_hoc", false)
    .in("status", statuses);

  if (filters.categoryId) {
    q = q.in("category_id", [...subtreeOf(categories, filters.categoryId)]);
  }
  if (filters.maxPriority !== undefined) q = q.lte("priority", filters.maxPriority);
  if (filters.deadlineBefore) q = q.lte("deadline", filters.deadlineBefore);
  if (filters.query?.trim()) {
    q = q.ilike("description", `%${likeLiteral(filters.query.trim())}%`);
  }

  const { data, error } = await q
    .order("priority")
    .order("deadline", { ascending: true, nullsFirst: false })
    .order("created_at")
    .limit(limit + 1);
  if (error) throw error;

  const paths = new Map(categories.map((c) => [c.id, c.path]));
  const found = (data ?? []) as TaskRow[];
  const placements = await livePlacements(
    db,
    found.map((t) => t.id),
  );
  const rows = found.map(
    (task): ListedTask => ({
      ...task,
      category_path: paths.get(task.category_id) ?? "(unknown category)",
      placed_minutes: placements.get(task.id)?.minutes ?? 0,
    }),
  );
  rows.sort(compareTasks);
  return { tasks: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * One task with its placement, or null when it does not exist for this user.
 * `placements` counts live placements only — blocks that are not skipped.
 */
export async function getTask(
  db: SupabaseClient,
  userId: string,
  id: string,
): Promise<(TaskRow & { placed_minutes: number; placements: number }) | null> {
  const { data, error } = await db
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const task = data as TaskRow;
  const placement = (await livePlacements(db, [task.id])).get(task.id);
  return {
    ...task,
    placements: placement?.count ?? 0,
    placed_minutes: placement?.minutes ?? 0,
  };
}

/** Open (backlog or scheduled, not ad-hoc) task count per category id. */
export async function openTaskCounts(
  db: SupabaseClient,
  userId: string,
): Promise<Map<string, number>> {
  const { data, error } = await db
    .from("tasks")
    .select("category_id")
    .eq("user_id", userId)
    .eq("ad_hoc", false)
    .in("status", ["backlog", "scheduled"]);
  if (error) throw error;
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const id = row.category_id as string;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
