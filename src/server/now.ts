import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { categoryIndex, DEFAULT_COLOR } from "@/lib/categories";
import { addDaysISO, localDate, startOfLocalDay } from "@/lib/agenda/zoned";
import { APP_TIMEZONE } from "@/lib/jobs/format";
import type { Category } from "@/lib/types";
import { getRunningSession, type RunningSession } from "@/server/live/data";
import { decksWithCounts } from "@/server/flashcards/data";

/**
 * "What is going on right now" for the home page: the live session to get
 * back to, the agenda block in progress or next today, the cards due and the
 * next interview. Every part is read on its own and best effort — a section
 * whose table is missing or whose query fails is left out, never the page.
 */

export type NowBlock = {
  starts_at: string;
  ends_at: string;
  label: string;
  color: string;
  /** Under way at the time of reading. */
  current: boolean;
};

export type NowSummary = {
  live: RunningSession | null;
  /** The block under way, else the next one today; null when today is clear. */
  block: NowBlock | null;
  /** Planned blocks still to come today, the one above included. */
  blocksLeft: number;
  /** Cards to study today within the daily limits; null when unknown. */
  cardsDue: number | null;
  interview: { starts_at: string; kind: string; company: string } | null;
};

async function settle<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

export async function loadLive(db: SupabaseClient, userId: string): Promise<RunningSession | null> {
  return settle(getRunningSession(db, userId), null);
}

async function loadToday(db: SupabaseClient, userId: string, now: Date): Promise<{ block: NowBlock | null; left: number }> {
  const today = localDate(now, APP_TIMEZONE);
  const dayEnd = startOfLocalDay(addDaysISO(today, 1), APP_TIMEZONE);
  const { data, error } = await db
    .from("task_sessions")
    .select("starts_at, ends_at, tasks(description, category_id)")
    .eq("user_id", userId)
    .eq("status", "planned")
    .gt("ends_at", now.toISOString())
    .lt("starts_at", dayEnd.toISOString())
    .order("starts_at")
    .limit(20);
  if (error) throw error;
  const rows = (data ?? []) as unknown as {
    starts_at: string;
    ends_at: string;
    tasks: { description: string | null; category_id: string } | null;
  }[];
  const first = rows.find((r) => r.tasks);
  if (!first) return { block: null, left: 0 };

  const { data: cats } = await db.from("categories").select("id, parent_id, name, color, position, archived").eq("user_id", userId);
  const cat = categoryIndex((cats ?? []) as Category[]).get(first.tasks!.category_id);
  const description = first.tasks!.description?.trim();
  return {
    block: {
      starts_at: first.starts_at,
      ends_at: first.ends_at,
      label: description || cat?.path || "Block",
      color: cat?.effectiveColor ?? DEFAULT_COLOR,
      current: Date.parse(first.starts_at) <= now.getTime(),
    },
    left: rows.filter((r) => r.tasks).length,
  };
}

async function loadCardsDue(db: SupabaseClient, userId: string, now: Date): Promise<number> {
  const { total } = await decksWithCounts(db, userId, now);
  return total.newCards + total.learningDue + total.reviewDue;
}

async function loadInterview(db: SupabaseClient, userId: string, now: Date): Promise<NowSummary["interview"]> {
  const { data, error } = await db
    .from("interviews")
    .select("starts_at, kind, applications(companies(name))")
    .eq("user_id", userId)
    .gt("ends_at", now.toISOString())
    .order("starts_at")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as unknown as {
    starts_at: string;
    kind: string;
    applications: { companies: { name: string } | { name: string }[] | null } | null;
  };
  const c = row.applications?.companies;
  return { starts_at: row.starts_at, kind: row.kind, company: (Array.isArray(c) ? c[0]?.name : c?.name) ?? "?" };
}

export async function loadNow(db: SupabaseClient, userId: string, now = new Date()): Promise<NowSummary> {
  const [live, today, cardsDue, interview] = await Promise.all([
    loadLive(db, userId),
    settle(loadToday(db, userId, now), { block: null, left: 0 }),
    settle<number | null>(loadCardsDue(db, userId, now), null),
    settle(loadInterview(db, userId, now), null),
  ]);
  return { live, block: today.block, blocksLeft: today.left, cardsDue, interview };
}
