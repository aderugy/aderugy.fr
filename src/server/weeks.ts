import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Week } from "@/lib/types";
import { summaryFromRow, type SessionSummary } from "@/lib/agenda/sessions";

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
 * Per task: its live session and its history, from `task_session_summary`
 * (migration 0025). A task with no session has no entry.
 *
 * There is no status to recompute after a write any more: a trigger keeps a
 * task's status in step with its sessions.
 */
export async function sessionSummaries(
  supabase: SupabaseClient,
  taskIds: string[],
): Promise<Map<string, SessionSummary>> {
  const ids = [...new Set(taskIds)].filter(Boolean);
  const out = new Map<string, SessionSummary>();
  if (ids.length === 0) return out;

  const { data, error } = await supabase.rpc("task_session_summary", { p_task_ids: ids });
  if (error) throw error;
  for (const row of (data ?? []) as (Parameters<typeof summaryFromRow>[0] & { task_id: string })[]) {
    out.set(row.task_id, summaryFromRow(row));
  }
  return out;
}
