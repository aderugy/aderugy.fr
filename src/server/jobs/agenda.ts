import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Result } from "@/server/agenda/tasks";
import { ensureWeek, syncTaskStatus } from "@/server/weeks";
import { isoWeekStartInTimeZone } from "@/lib/time";
import { TASK_LIMITS } from "@/lib/agenda/backlog";
import { interviewTitle, type Interview, type InterviewKind } from "@/lib/jobs/types";
import { INTERVIEW_COLUMNS, getInterview } from "./data";

/**
 * Interviews on the agenda.
 *
 * An interview's time is held by a scheduled block, created here with one
 * ad-hoc task inside it — under the interview category Arthur picks — so it
 * counts in the week's distribution and is pushed to Google like any block.
 * The block's title is the interview's ("Interview · Betclic (technical)").
 *
 * The block is the source of truth for the time once it exists: moving the
 * interview here moves the block, and a trigger (migration 0017) copies any
 * move of the block back onto the interview, so a drag on the grid is enough.
 *
 * Browser only. Connected apps cannot write scheduled blocks (0015), and
 * scheduling from Claude is deliberately not offered.
 */

const APP_TIMEZONE = process.env.NEXT_PUBLIC_APP_TIMEZONE ?? "Europe/Paris";

type TaskFlags = { ad_hoc: boolean; application_id: string | null };

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

/** A block holding one ad-hoc task for the interview. Returns the block id. */
async function createInterviewBlock(
  db: SupabaseClient,
  userId: string,
  input: { title: string; startsAt: Date; endsAt: Date; categoryId: string; applicationId: string },
): Promise<string> {
  const week = await ensureWeek(db, userId, isoWeekStartInTimeZone(input.startsAt, APP_TIMEZONE));
  const minutes = minutesBetween(input.startsAt, input.endsAt);

  const { data: block, error } = await db
    .from("scheduled_blocks")
    .insert({
      user_id: userId,
      week_id: week.id,
      starts_at: input.startsAt.toISOString(),
      ends_at: input.endsAt.toISOString(),
      description: input.title,
    })
    .select("id")
    .single();
  if (error) throw error;

  try {
    const { data: task, error: taskError } = await db
      .from("tasks")
      .insert({
        user_id: userId,
        category_id: input.categoryId,
        description: input.title,
        estimated_minutes: Math.min(Math.max(minutes, TASK_LIMITS.minMinutes), TASK_LIMITS.maxMinutes),
        priority: 2,
        status: "scheduled",
        ad_hoc: true,
        application_id: input.applicationId,
      })
      .select("id")
      .single();
    if (taskError) throw taskError;

    const { error: linkError } = await db.from("scheduled_block_tasks").insert({
      user_id: userId,
      scheduled_block_id: block.id,
      task_id: task.id,
      planned_minutes: minutes,
      position: 0,
    });
    if (linkError) throw linkError;
  } catch (e) {
    // No half-made block left on the grid.
    await db.from("scheduled_blocks").delete().eq("user_id", userId).eq("id", block.id);
    throw e;
  }
  return block.id as string;
}

/** Delete a block and the ad-hoc tasks that only existed inside it. */
async function deleteBlock(db: SupabaseClient, userId: string, blockId: string): Promise<void> {
  const { data: links, error: readError } = await db
    .from("scheduled_block_tasks")
    .select("task_id, tasks(ad_hoc)")
    .eq("user_id", userId)
    .eq("scheduled_block_id", blockId);
  if (readError) throw readError;

  const { error } = await db.from("scheduled_blocks").delete().eq("user_id", userId).eq("id", blockId);
  if (error) throw error;

  const rows = (links ?? []) as unknown as { task_id: string; tasks: { ad_hoc: boolean } | { ad_hoc: boolean }[] | null }[];
  const adHoc = rows.filter((l) => (Array.isArray(l.tasks) ? l.tasks[0]?.ad_hoc : l.tasks?.ad_hoc)).map((l) => l.task_id);
  const others = rows.map((l) => l.task_id).filter((id) => !adHoc.includes(id));
  if (adHoc.length) {
    const { error: e } = await db.from("tasks").delete().eq("user_id", userId).in("id", adHoc);
    if (e) throw e;
  }
  // A prep task you had dropped into the interview's block goes back to the backlog.
  await syncTaskStatus(db, userId, others);
}

export type NewInterview = {
  applicationId: string;
  kind: InterviewKind;
  startsAt: string;
  endsAt: string;
  withWhom?: string | null;
  location?: string | null;
  /** Category of the block's task. Null keeps the interview off the agenda. */
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

  const blockId = input.categoryId
    ? await createInterviewBlock(db, userId, {
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
      scheduled_block_id: blockId,
      kind: input.kind,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      with_whom: input.withWhom?.trim() || null,
      location: input.location?.trim() || null,
    })
    .select(INTERVIEW_COLUMNS)
    .single();
  if (error) {
    if (blockId) await deleteBlock(db, userId, blockId);
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

/** New time for an interview: its block moves, and the trigger carries the interview along. */
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

  if (interview.scheduled_block_id) {
    const blockId = interview.scheduled_block_id;
    const { error } = await db
      .from("scheduled_blocks")
      .update({ starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() })
      .eq("user_id", userId)
      .eq("id", blockId);
    if (error) throw error;
    // The interview's own task fills the block; resize it with the block.
    const { data: links, error: readError } = await db
      .from("scheduled_block_tasks")
      .select("task_id, tasks(ad_hoc, application_id)")
      .eq("user_id", userId)
      .eq("scheduled_block_id", blockId);
    if (readError) throw readError;
    type Link = { task_id: string; tasks: TaskFlags | TaskFlags[] | null };
    const own = ((links ?? []) as unknown as Link[]).find((l) => {
      const t = Array.isArray(l.tasks) ? l.tasks[0] : l.tasks;
      return t?.ad_hoc && t.application_id === interview.application_id;
    });
    if (own) {
      const { error: e } = await db
        .from("scheduled_block_tasks")
        .update({ planned_minutes: minutesBetween(startsAt, endsAt) })
        .eq("user_id", userId)
        .eq("scheduled_block_id", blockId)
        .eq("task_id", own.task_id);
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

/** Keep the block's title in step with the interview (kind or company changed). */
export async function retitleInterviewBlock(db: SupabaseClient, userId: string, id: string): Promise<void> {
  const interview = await getInterview(db, userId, id);
  if (!interview?.scheduled_block_id) return;
  const app = await companyOf(db, userId, interview.application_id);
  if (!app) return;
  const title = interviewTitle(app.company, interview.kind);

  const { error } = await db
    .from("scheduled_blocks")
    .update({ description: title })
    .eq("user_id", userId)
    .eq("id", interview.scheduled_block_id);
  if (error) throw error;

  const { data: links, error: readError } = await db
    .from("scheduled_block_tasks")
    .select("task_id")
    .eq("user_id", userId)
    .eq("scheduled_block_id", interview.scheduled_block_id);
  if (readError) throw readError;
  const ids = (links ?? []).map((l) => l.task_id as string);
  if (ids.length === 0) return;
  const { error: e } = await db
    .from("tasks")
    .update({ description: title })
    .eq("user_id", userId)
    .eq("ad_hoc", true)
    .eq("application_id", interview.application_id)
    .in("id", ids);
  if (e) throw e;
}

/** Put an interview whose block was deleted back on the agenda. */
export async function putInterviewOnAgenda(
  db: SupabaseClient,
  userId: string,
  id: string,
  categoryId: string,
): Promise<Result> {
  if (!categoryId) return { ok: false, error: "Pick a category for the agenda." };
  const interview = await getInterview(db, userId, id);
  if (!interview) return { ok: false, error: "No such interview." };
  if (interview.scheduled_block_id) return { ok: true };
  const app = await companyOf(db, userId, interview.application_id);
  if (!app) return { ok: false, error: "No such application." };

  const blockId = await createInterviewBlock(db, userId, {
    title: interviewTitle(app.company, interview.kind),
    startsAt: new Date(interview.starts_at),
    endsAt: new Date(interview.ends_at),
    categoryId,
    applicationId: interview.application_id,
  });
  const { error } = await db
    .from("interviews")
    .update({ scheduled_block_id: blockId })
    .eq("user_id", userId)
    .eq("id", id);
  if (error) {
    await deleteBlock(db, userId, blockId);
    throw error;
  }
  return { ok: true };
}

/** Delete an interview, and its block with it. */
export async function removeInterview(db: SupabaseClient, userId: string, id: string): Promise<Result> {
  const interview = await getInterview(db, userId, id);
  if (!interview) return { ok: false, error: "No such interview." };
  if (interview.scheduled_block_id) await deleteBlock(db, userId, interview.scheduled_block_id);
  const { error } = await db.from("interviews").delete().eq("user_id", userId).eq("id", id);
  if (error) throw error;
  return { ok: true };
}

/** Delete an application; its interviews' blocks leave the agenda with it. */
export async function removeApplication(db: SupabaseClient, userId: string, id: string): Promise<Result> {
  const { data, error } = await db
    .from("interviews")
    .select("scheduled_block_id")
    .eq("user_id", userId)
    .eq("application_id", id)
    .not("scheduled_block_id", "is", null);
  if (error) throw error;
  for (const row of data ?? []) await deleteBlock(db, userId, row.scheduled_block_id as string);

  const { error: e, count } = await db
    .from("applications")
    .delete({ count: "exact" })
    .eq("user_id", userId)
    .eq("id", id);
  if (e) throw e;
  if (!count) return { ok: false, error: "No such application." };
  return { ok: true };
}
