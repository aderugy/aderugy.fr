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

/** Live placements per task: links to blocks that are not skipped. */
export async function livePlacements(
  supabase: SupabaseClient,
  taskIds: string[],
): Promise<Map<string, { count: number; minutes: number; total: number }>> {
  const ids = [...new Set(taskIds)].filter(Boolean);
  const out = new Map<string, { count: number; minutes: number; total: number }>();
  if (ids.length === 0) return out;

  const { data, error } = await supabase.rpc("task_placements", { p_task_ids: ids });
  if (error) throw error;
  for (const row of (data ?? []) as {
    task_id: string;
    live_count: number;
    live_minutes: number;
    total_count: number;
  }[]) {
    out.set(row.task_id, {
      count: row.live_count,
      minutes: row.live_minutes,
      total: row.total_count,
    });
  }
  return out;
}

/**
 * A task counts as scheduled when it sits in at least one block that is not
 * skipped. Skipping a block means the work did not happen, so its tasks go
 * back to the backlog — the link stays, so the skipped block still shows what
 * was planned. Deriving it after every placement or status change keeps the
 * backlog rail honest without a trigger. `done` and `dropped` are user intent
 * and stay untouched; ad-hoc tasks belong to their block and are left alone.
 */
export async function syncTaskStatus(
  supabase: SupabaseClient,
  userId: string,
  taskIds: string[],
) {
  const ids = [...new Set(taskIds)].filter(Boolean);
  if (ids.length === 0) return;

  const placements = await livePlacements(supabase, ids);
  const nowScheduled = ids.filter((id) => (placements.get(id)?.count ?? 0) > 0);
  const nowFree = ids.filter((id) => (placements.get(id)?.count ?? 0) === 0);

  if (nowScheduled.length) {
    const { error } = await supabase
      .from("tasks")
      .update({ status: "scheduled" })
      .eq("user_id", userId)
      .eq("status", "backlog")
      .eq("ad_hoc", false)
      .in("id", nowScheduled);
    if (error) throw error;
  }
  if (nowFree.length) {
    const { error } = await supabase
      .from("tasks")
      .update({ status: "backlog" })
      .eq("user_id", userId)
      .eq("status", "scheduled")
      .eq("ad_hoc", false)
      .in("id", nowFree);
    if (error) throw error;
  }
}
