/**
 * Sessions, as pure functions: what the grid, the week's totals and the
 * backlog all agree on. A session is one task at one span of time; see
 * migration 0026 for the model.
 */

import type { SessionStatus } from "@/lib/types";

type Spanned = { starts_at: string; ends_at: string };
type WithStatus = Spanned & { status: SessionStatus };

/** Minutes a session occupies. */
export function sessionMinutes(s: Spanned): number {
  return Math.round((Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 60_000);
}

/**
 * Planned, and its time is over: the work was neither marked done nor
 * skipped. Never stored — a session becomes missed by the clock alone.
 */
export function isMissed(s: WithStatus, now: number): boolean {
  return s.status === "planned" && Date.parse(s.ends_at) <= now;
}

/**
 * Whether moving this session to another time should keep a trace of it.
 *
 * Moving a slot that has not started yet is just a change of plan: nothing
 * happened there. Moving one whose start has passed is a reschedule — the old
 * slot stays in the task's history as skipped, and a new one is planned.
 */
export function moveReschedules(s: WithStatus, now: number): boolean {
  return s.status === "planned" && Date.parse(s.starts_at) < now;
}

/**
 * Whether deleting the session outright is honest. Only a planned slot that
 * has not started: anything the clock has reached is history, and goes
 * through skip instead.
 */
export function canUnschedule(s: WithStatus, now: number): boolean {
  return s.status === "planned" && Date.parse(s.starts_at) > now;
}

/** Sessions that count towards the week: everything but skipped ones. */
export function counts(s: { status: SessionStatus }): boolean {
  return s.status !== "skipped";
}

/**
 * Minutes per category over a set of sessions: each one counts for its own
 * length against its task's category, unless it was skipped. Same rule as the
 * `week_category_minutes` view.
 */
export function minutesByCategory(
  sessions: (WithStatus & { category_id: string | null })[],
): { planned: Map<string, number>; done: Map<string, number> } {
  const planned = new Map<string, number>();
  const done = new Map<string, number>();
  for (const s of sessions) {
    if (!counts(s) || !s.category_id) continue;
    const m = sessionMinutes(s);
    if (m <= 0) continue;
    planned.set(s.category_id, (planned.get(s.category_id) ?? 0) + m);
    if (s.status === "done") done.set(s.category_id, (done.get(s.category_id) ?? 0) + m);
  }
  return { planned, done };
}

/** A task's sessions, summed up for a row in the backlog. */
export type SessionSummary = {
  /** The live session, if any. */
  plannedId: string | null;
  plannedStarts: string | null;
  plannedEnds: string | null;
  doneCount: number;
  skippedCount: number;
  /** When the last skipped attempt was planned to start. */
  lastSkipped: string | null;
};

export const NO_SESSIONS: SessionSummary = {
  plannedId: null,
  plannedStarts: null,
  plannedEnds: null,
  doneCount: 0,
  skippedCount: 0,
  lastSkipped: null,
};

/** One row of the `task_session_summary` function, as the app uses it. */
export function summaryFromRow(row: {
  planned_id: string | null;
  planned_starts: string | null;
  planned_ends: string | null;
  done_count: number;
  skipped_count: number;
  last_skipped: string | null;
}): SessionSummary {
  return {
    plannedId: row.planned_id,
    plannedStarts: row.planned_starts,
    plannedEnds: row.planned_ends,
    doneCount: row.done_count,
    skippedCount: row.skipped_count,
    lastSkipped: row.last_skipped,
  };
}
