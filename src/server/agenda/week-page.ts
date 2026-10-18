import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureWeek } from "@/server/weeks";
import { LISTED_TASKS } from "@/server/agenda/tasks";
import type { InterviewOnSession } from "@/lib/jobs/types";
import type {
  CalendarSource,
  Category,
  ExternalEvent,
  GoogleAccount,
  HiddenEventRule,
  Objective,
  Task,
  TaskSession,
  Week,
} from "@/lib/types";

/** Everything the week page draws, before any shaping for display. */
export type WeekPageData = {
  week: Week;
  categories: Category[];
  tasks: Task[];
  /** Sessions in the window, each with its task embedded (`tasks`) and the interview it holds, if any. */
  sessions: TaskSession[];
  objectives: Objective[];
  externalEvents: ExternalEvent[];
  calendarSources: CalendarSource[];
  googleAccount: GoogleAccount | null;
  syncState: { google_calendar_id: string; last_synced_at: string | null }[];
  hiddenEvents: HiddenEventRule[];
};

export type WeekPageLoad = { ok: true; data: WeekPageData } | { ok: false; error: string };

type Window = { weekStart: string; rangeStart: string; rangeEnd: string };

/**
 * Load one week for /agenda.
 *
 * One call to `agenda_week` (migration 0030), which does in the database what
 * the page used to do in three trips: find or create the week, the nine reads,
 * then the interviews on its sessions.
 *
 * Until that function exists — the code and the migration reach production a
 * few seconds apart, in either order — it falls back to the queries it
 * replaced, so a deploy never shows a broken week.
 */
export async function loadWeekPage(
  supabase: SupabaseClient,
  userId: string,
  window: Window,
): Promise<WeekPageLoad> {
  const { data, error } = await supabase.rpc("agenda_week", {
    p_week_start: window.weekStart,
    p_range_start: window.rangeStart,
    p_range_end: window.rangeEnd,
  });

  if (!error && data) {
    const d = data as {
      week: Week;
      categories: Category[];
      tasks: Task[];
      sessions: TaskSession[];
      objectives: Objective[];
      external_events: ExternalEvent[];
      calendar_sources: CalendarSource[];
      google_account: GoogleAccount | null;
      sync_state: WeekPageData["syncState"];
      hidden_events: HiddenEventRule[];
    };
    return {
      ok: true,
      data: {
        week: d.week,
        categories: d.categories,
        tasks: d.tasks,
        sessions: d.sessions.filter((s) => s.tasks),
        objectives: d.objectives,
        externalEvents: d.external_events,
        calendarSources: d.calendar_sources,
        googleAccount: d.google_account,
        syncState: d.sync_state,
        hiddenEvents: d.hidden_events,
      },
    };
  }

  // PGRST202: PostgREST does not know the function (not migrated yet, or its
  // schema cache has not reloaded). Anything else is a real failure.
  if (error && error.code !== "PGRST202") return { ok: false, error: error.message };
  return loadWeekByQueries(supabase, userId, window);
}

type InterviewRow = Omit<InterviewOnSession, "company" | "role_title"> & {
  session_id: string;
  applications: { role_title: string; companies: { name: string } | { name: string }[] | null } | null;
};

/**
 * Mark the sessions that hold a /jobs interview. A separate query rather than
 * an embed, and its failure ignored: the week must still render without it.
 */
async function withInterviews(
  supabase: SupabaseClient,
  sessions: TaskSession[],
): Promise<TaskSession[]> {
  if (sessions.length === 0) return sessions;
  const { data, error } = await supabase
    .from("interviews")
    .select("id, application_id, session_id, kind, prep_notes, debrief_notes, applications(role_title, companies(name))")
    .in(
      "session_id",
      sessions.map((s) => s.id),
    );
  if (error || !data?.length) return sessions;

  const bySession = new Map<string, InterviewOnSession>();
  for (const row of data as unknown as InterviewRow[]) {
    const { applications, session_id, ...rest } = row;
    const c = applications?.companies;
    bySession.set(session_id, {
      ...rest,
      role_title: applications?.role_title ?? "",
      company: (Array.isArray(c) ? c[0]?.name : c?.name) ?? "",
    });
  }
  return sessions.map((s) => (bySession.has(s.id) ? { ...s, interview: bySession.get(s.id)! } : s));
}

/** The pre-0030 path: the same reads as separate PostgREST queries. */
async function loadWeekByQueries(
  supabase: SupabaseClient,
  userId: string,
  { weekStart, rangeStart, rangeEnd }: Window,
): Promise<WeekPageLoad> {
  const week = await ensureWeek(supabase, userId, weekStart);

  const [
    categoriesRes,
    tasksRes,
    scheduledRes,
    objectivesRes,
    externalRes,
    sourcesRes,
    googleRes,
    syncRes,
    hiddenRes,
  ] = await Promise.all([
    supabase
      .from("categories")
      .select("id, parent_id, name, color, position, archived")
      .eq("user_id", userId)
      .eq("archived", false)
      .order("position"),
    supabase
      .from("tasks")
      .select(
        "id, category_id, description, notes, estimated_minutes, priority, deadline, status, splittable, ad_hoc, completed_at, created_at",
      )
      .eq("user_id", userId)
      .in("status", ["backlog", "scheduled"])
      // The rail is for work waiting on a slot; an interview's own task is
      // the interview, and reaches the grid through its session.
      .or(LISTED_TASKS)
      .order("created_at"),
    // Filtered by time range rather than week_id so a session shows where
    // it actually sits, whatever week it was planned from.
    supabase
      .from("task_sessions")
      .select(
        "id, task_id, week_id, starts_at, ends_at, status, created_by, tasks(id, category_id, description, notes, estimated_minutes, priority, deadline, status, created_at)",
      )
      .eq("user_id", userId)
      .gte("starts_at", rangeStart)
      .lt("starts_at", rangeEnd)
      .order("starts_at"),
    supabase
      .from("objectives")
      .select("id, week_id, title, category_id, target_minutes, done, position")
      .eq("week_id", week.id)
      .order("position"),
    // The mirror of what Google says you are already committed to, plus the
    // archives: events a calendar deleted once they were over, which the
    // planner keeps so a week already lived does not lose its hours.
    supabase
      .from("external_events")
      .select(
        "calendar_source_id, external_event_id, title, starts_at, ends_at, all_day, status, transparency, attendee_response, archived_at",
      )
      .eq("user_id", userId)
      .lt("starts_at", rangeEnd)
      .gt("ends_at", rangeStart)
      .order("starts_at"),
    supabase
      .from("calendar_sources")
      .select(
        "id, provider, external_id, display_name, color, category_id, enabled, include_all_day, include_free, include_declined, position",
      )
      .eq("user_id", userId)
      .order("position"),
    supabase
      .from("google_accounts")
      .select("google_email, connected_at, disconnected_at, last_error, last_error_at")
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("google_sync_state")
      .select("google_calendar_id, last_synced_at")
      .eq("user_id", userId),
    // Events Arthur hid. Unreadable rules hide nothing rather than fail the week.
    supabase
      .from("hidden_external_events")
      .select("id, calendar_source_id, external_event_id, title, label, starts_at, created_at")
      .eq("user_id", userId),
  ]);

  // Calendar errors are deliberately excluded: a broken integration degrades
  // the planner, it does not replace it with an error page.
  const error =
    categoriesRes.error ?? tasksRes.error ?? scheduledRes.error ?? objectivesRes.error;
  if (error) return { ok: false, error: error.message };

  const sessions = await withInterviews(
    supabase,
    ((scheduledRes.data ?? []) as unknown as TaskSession[]).filter((s) => s.tasks),
  );

  return {
    ok: true,
    data: {
      week,
      categories: (categoriesRes.data ?? []) as Category[],
      tasks: (tasksRes.data ?? []) as Task[],
      sessions,
      objectives: (objectivesRes.data ?? []) as Objective[],
      externalEvents: (externalRes.data ?? []) as ExternalEvent[],
      calendarSources: (sourcesRes.data ?? []) as CalendarSource[],
      googleAccount: (googleRes.data ?? null) as GoogleAccount | null,
      syncState: (syncRes.data ?? []) as WeekPageData["syncState"],
      hiddenEvents: (hiddenRes.data ?? []) as HiddenEventRule[],
    },
  };
}
