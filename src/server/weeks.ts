import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Week } from "@/lib/types";

/**
 * Weeks are created lazily: the first time you open or touch a week, its row
 * appears. `upsert` on the (user_id, week_start) unique index makes this safe
 * against two concurrent requests for the same week.
 */
export async function ensureWeek(
  supabase: SupabaseClient,
  userId: string,
  weekStart: string,
): Promise<Week> {
  const { data: existing, error: readError } = await supabase
    .from("weeks")
    .select("id, week_start, theme, guidelines")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (readError) throw readError;
  if (existing) return existing as Week;

  const { data, error } = await supabase
    .from("weeks")
    .upsert(
      { user_id: userId, week_start: weekStart },
      { onConflict: "user_id,week_start" },
    )
    .select("id, week_start, theme, guidelines")
    .single();
  if (error) throw error;
  return data as Week;
}

/**
 * A task counts as scheduled when it is attached to at least one scheduled
 * block. Deriving it after every placement keeps the backlog rail honest
 * without a trigger. `done` and `dropped` are user intent and stay untouched.
 */
export async function syncTaskStatus(
  supabase: SupabaseClient,
  userId: string,
  taskIds: string[],
) {
  const ids = [...new Set(taskIds)].filter(Boolean);
  if (ids.length === 0) return;

  const { data: links } = await supabase
    .from("scheduled_block_tasks")
    .select("task_id")
    .eq("user_id", userId)
    .in("task_id", ids);

  const scheduled = new Set((links ?? []).map((l) => l.task_id as string));
  const nowScheduled = ids.filter((id) => scheduled.has(id));
  const nowFree = ids.filter((id) => !scheduled.has(id));

  if (nowScheduled.length) {
    await supabase
      .from("tasks")
      .update({ status: "scheduled" })
      .eq("user_id", userId)
      .eq("status", "backlog")
      .in("id", nowScheduled);
  }
  if (nowFree.length) {
    await supabase
      .from("tasks")
      .update({ status: "backlog" })
      .eq("user_id", userId)
      .eq("status", "scheduled")
      .in("id", nowFree);
  }
}
