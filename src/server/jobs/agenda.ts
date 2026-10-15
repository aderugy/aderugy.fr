import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Result } from "@/server/agenda/tasks";
import { ensureWeek } from "@/server/weeks";
import { isoWeekStartInTimeZone } from "@/lib/time";
import { TASK_LIMITS } from "@/lib/agenda/backlog";
import { interviewTitle, type Interview, type InterviewKind } from "@/lib/jobs/types";
import { INTERVIEW_COLUMNS, getInterview } from "./data";

/**
 * Interviews on the agenda.
 *
 * An interview's time is held by a session of its own task — under the
 * interview category Arthur picks — so it counts in the week's distribution
 * and is pushed to Google like any slot. The task is flagged ad_hoc and
 * linked to the application: the interview stands for it, so the backlog
 * leaves it out. Its description is the interview's title
 * ("Interview · Betclic (technical)").
 *
 * The session is the source of truth for the time once it exists: moving the
 * interview here moves the session, and a trigger (migration 0025) copies any
 * move of the session back onto the interview, so a drag on the grid is enough.
 *
 * Browser only: scheduling from Claude is deliberately not offered.
 */

const APP_TIMEZONE = process.env.NEXT_PUBLIC_APP_TIMEZONE ?? "Europe/Paris";

function minutesBetween(startsAt: Date, endsAt: Date): number {
  return Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);
}

function checkSpan(startsAt: Date, endsAt: Date): string | null {
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return "Pick a start and an end.";
  if (endsAt <= startsAt) return "The end must be after the start.";
  const minutes = minutesBetween(startsAt, endsAt);
  if (minutes < TASK_LIMITS.minMinutes) return `An interview lasts at least ${TASK_LIMITS.minMinutes} minutes.`;
  if (minutes > 12 * 60) return "An interview longer than 12 hours is probably a typo.";
  return null;
}

/** The category of the last interview put on the agenda — the default for the next one. */
export async function lastInterviewCategory(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await db
    .from("tasks")
    .select("category_id")
    .eq("user_id", userId)
    .eq("ad_hoc", true)
    .not("application_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data ?? [])[0]?.category_id as string | undefined) ?? null;
}

async function companyOf(db: SupabaseClient, userId: string, applicationId: string) {
  const { data, error } = await db
    .from("applications")
    .select("id, status, companies(name)")
    .eq("user_id", userId)
    .eq("id", applicationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const c = data.companies as { name: string } | { name: string }[] | null;
  const name = (Array.isArray(c) ? c[0]?.name : c?.name) ?? "Company";
  return { status: data.status as string, company: name };
}

/** The interview's own task, and its session on the grid. Returns the session id. */
async function createInterviewSession(
  db: SupabaseClient,
  userId: string,
  input: { title: string; startsAt: Date; endsAt: Date; categoryId: string; applicationId: string },
): Promise<string> {
  const week = await ensureWeek(db, userId, isoWeekStartInTimeZone(input.startsAt, APP_TIMEZONE));
  const minutes = minutesBetween(input.startsAt, input.endsAt);

  const { data: task, error: taskError } = await db
    .from("tasks")
    .insert({
      user_id: userId,
      category_id: input.categoryId,
      description: input.title,
      estimated_minutes: Math.min(Math.max(minutes, TASK_LIMITS.minMinutes), TASK_LIMITS.maxMinutes),
      priority: 2,
      ad_hoc: true,
      application_id: input.applicationId,
    })
    .select("id")
    .single();
  if (taskError) throw taskError;

  const { data: session, error } = await db
    .from("task_sessions")
    .insert({
      user_id: userId,
      task_id: task.id,
      week_id: week.id,
      starts_at: input.startsAt.toISOString(),
      ends_at: input.endsAt.toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    // No task left behind without its slot.
    await db.from("tasks").delete().eq("user_id", userId).eq("id", task.id);
    throw error;
  }
  return session.id as string;
}

/**
 * Take an interview off the agenda: its own task goes, and its session with
 * it (cascade). A session holding some other task only loses the slot.
 */
async function deleteInterviewSession(db: SupabaseClient, userId: string, sessionId: string): Promise<void> {
  const { data, error: readError } = await db
    .from("task_sessions")
    .select("task_id, tasks(ad_hoc, application_id)")
    .eq("user_id", userId)
    .eq("id", sessionId)
    .maybeSingle();
  if (readError) throw readError;
  if (!data) return;
  const t = data.tasks as { ad_hoc: boolean; application_id: string | null } | { ad_hoc: boolean; application_id: string | null }[] | null;
  const task = Array.isArray(t) ? t[0] : t;
  if (task?.ad_hoc && task.application_id) {
    const { error } = await db.from("tasks").delete().eq("user_id", userId).eq("id", data.task_id);
    if (error) throw error;
  } else {
    const { error } = await db.from("task_sessions").delete().eq("user_id", userId).eq("id", sessionId);
    if (error) throw error;
  }
}

export type NewInterview = {
  applicationId: string;
  kind: InterviewKind;
  startsAt: string;
  endsAt: string;
  withWhom?: string | null;
  location?: string | null;
  /** Category of the interview's task. Null keeps the interview off the agenda. */
  categoryId: string | null;
};

export async function scheduleInterview(
  db: SupabaseClient,
  userId: string,
  input: NewInterview,
): Promise<Result<Interview>> {
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  const problem = checkSpan(startsAt, endsAt);
  if (problem) return { ok: false, error: problem };

  const app = await companyOf(db, userId, input.applicationId);
  if (!app) return { ok: false, error: "No such application." };

  const sessionId = input.categoryId
    ? await createInterviewSession(db, userId, {
        title: interviewTitle(app.company, input.kind),
        startsAt,
        endsAt,
        categoryId: input.categoryId,
        applicationId: input.applicationId,
      })
    : null;

  const { data, error } = await db
    .from("interviews")
    .insert({
      user_id: userId,
      application_id: input.applicationId,
      session_id: sessionId,
      kind: input.kind,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      with_whom: input.withWhom?.trim() || null,
      location: input.location?.trim() || null,
    })
    .select(INTERVIEW_COLUMNS)
    .single();
  if (error) {
    if (sessionId) await deleteInterviewSession(db, userId, sessionId);
    throw error;
  }

  // An interview means the application is in the interview stage — unless it
  // is already further along (an offer) or closed.
  if (app.status === "to_apply" || app.status === "applied") {
    const { error: e } = await db
      .from("applications")
      .update({ status: "interviewing" })
      .eq("user_id", userId)
      .eq("id", input.applicationId);
    if (e) throw e;
  }
  return { ok: true, value: data as Interview };
}

/** New time for an interview: its session moves, and the trigger carries the interview along. */
export async function moveInterview(
  db: SupabaseClient,
  userId: string,
  id: string,
  startsAtIso: string,
  endsAtIso: string,
): Promise<Result> {
  const startsAt = new Date(startsAtIso);
  const endsAt = new Date(endsAtIso);
  const problem = checkSpan(startsAt, endsAt);
  if (problem) return { ok: false, error: problem };

  const interview = await getInterview(db, userId, id);
  if (!interview) return { ok: false, error: "No such interview." };

  if (interview.session_id) {
    // An appointment that moved is a new time for the same slot, not a
    // reschedule: no skipped trace is left behind, even for a past one.
    const week = await ensureWeek(db, userId, isoWeekStartInTimeZone(startsAt, APP_TIMEZONE));
    const { data: session, error } = await db
      .from("task_sessions")
      .update({ starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), week_id: week.id })
      .eq("user_id", userId)
      .eq("id", interview.session_id)
      .select("task_id")
      .maybeSingle();
    if (error) throw error;
    if (session) {
      const minutes = minutesBetween(startsAt, endsAt);
      const { error: e } = await db
        .from("tasks")
        .update({ estimated_minutes: Math.min(Math.max(minutes, TASK_LIMITS.minMinutes), TASK_LIMITS.maxMinutes) })
        .eq("user_id", userId)
        .eq("id", session.task_id)
        .eq("ad_hoc", true)
        .eq("application_id", interview.application_id);
      if (e) throw e;
    }
  }

  // Also written directly: covers an interview off the agenda, and costs
  // nothing when the trigger already did it.
  const { error } = await db
    .from("interviews")
    .update({ starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() })
    .eq("user_id", userId)
    .eq("id", id);
  if (error) throw error;
  return { ok: true };
}

/** Keep the interview's task title in step with the interview (kind or company changed). */
export async function retitleInterviewSession(db: SupabaseClient, userId: string, id: string): Promise<void> {
  const interview = await getInterview(db, userId, id);
  if (!interview?.session_id) return;
  const app = await companyOf(db, userId, interview.application_id);
  if (!app) return;
  const title = interviewTitle(app.company, interview.kind);

  const { data: session, error: readError } = await db
    .from("task_sessions")
    .select("task_id")
    .eq("user_id", userId)
    .eq("id", interview.session_id)
    .maybeSingle();
  if (readError) throw readError;
  if (!session) return;
  const { error } = await db
    .from("tasks")
    .update({ description: title })
    .eq("user_id", userId)
    .eq("id", session.task_id)
    .eq("ad_hoc", true)
    .eq("application_id", interview.application_id);
  if (error) throw error;
}

/** Put an interview whose slot was deleted back on the agenda. */
export async function putInterviewOnAgenda(
  db: SupabaseClient,
  userId: string,
  id: string,
  categoryId: string,
): Promise<Result> {
  if (!categoryId) return { ok: false, error: "Pick a category for the agenda." };
  const interview = await getInterview(db, userId, id);
  if (!interview) return { ok: false, error: "No such interview." };
  if (interview.session_id) return { ok: true };
  const app = await companyOf(db, userId, interview.application_id);
  if (!app) return { ok: false, error: "No such application." };

  const sessionId = await createInterviewSession(db, userId, {
    title: interviewTitle(app.company, interview.kind),
    startsAt: new Date(interview.starts_at),
    endsAt: new Date(interview.ends_at),
    categoryId,
    applicationId: interview.application_id,
  });
  const { error } = await db
    .from("interviews")
    .update({ session_id: sessionId })
    .eq("user_id", userId)
    .eq("id", id);
  if (error) {
    await deleteInterviewSession(db, userId, sessionId);
    throw error;
  }
  return { ok: true };
}

/** Delete an interview, and its slot with it. */
export async function removeInterview(db: SupabaseClient, userId: string, id: string): Promise<Result> {
  const interview = await getInterview(db, userId, id);
  if (!interview) return { ok: false, error: "No such interview." };
  if (interview.session_id) await deleteInterviewSession(db, userId, interview.session_id);
  const { error } = await db.from("interviews").delete().eq("user_id", userId).eq("id", id);
  if (error) throw error;
  return { ok: true };
}

/** Delete an application; its interviews' slots leave the agenda with it. */
export async function removeApplication(db: SupabaseClient, userId: string, id: string): Promise<Result> {
  const { data, error } = await db
    .from("interviews")
    .select("session_id")
    .eq("user_id", userId)
    .eq("application_id", id)
    .not("session_id", "is", null);
  if (error) throw error;
  for (const row of data ?? []) await deleteInterviewSession(db, userId, row.session_id as string);

  const { error: e, count } = await db
    .from("applications")
    .delete({ count: "exact" })
    .eq("user_id", userId)
    .eq("id", id);
  if (e) throw e;
  if (!count) return { ok: false, error: "No such application." };
  return { ok: true };
}
