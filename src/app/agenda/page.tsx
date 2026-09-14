import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { ensureWeek } from "@/server/weeks";
import { addDays, fromISODate, isoWeekStartInTimeZone, toISODate } from "@/lib/time";
import { WeekPlanner } from "@/components/agenda/WeekPlanner";
import type {
  Block,
  CalendarSource,
  Category,
  ExternalEvent,
  GoogleAccount,
  Objective,
  ScheduledBlock,
  Task,
} from "@/lib/types";

export const metadata = { title: "Week — Agenda" };

const APP_TIMEZONE = process.env.NEXT_PUBLIC_APP_TIMEZONE ?? "Europe/Paris";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function AgendaPage({ searchParams }: PageProps<"/agenda">) {
  const params = await searchParams;
  const requested = typeof params.w === "string" && ISO_DATE.test(params.w) ? params.w : null;
  const weekStart = requested ?? isoWeekStartInTimeZone(new Date(), APP_TIMEZONE);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Defence in depth: the proxy already gates this, but a bypassed or
  // misconfigured proxy must not render a blank page.
  if (!user) redirect(LOGIN_PATH);

  const week = await ensureWeek(supabase, user.id, weekStart);

  const weekStartDate = fromISODate(weekStart);
  const rangeStart = addDays(weekStartDate, -1).toISOString();
  const rangeEnd = addDays(weekStartDate, 8).toISOString();

  const [
    categoriesRes,
    tasksRes,
    blocksRes,
    scheduledRes,
    objectivesRes,
    externalRes,
    sourcesRes,
    googleRes,
    syncRes,
  ] = await Promise.all([
      supabase
        .from("categories")
        .select("id, parent_id, name, color, position, archived")
        .eq("user_id", user.id)
        .eq("archived", false)
        .order("position"),
      supabase
        .from("tasks")
        .select(
          "id, category_id, description, estimated_minutes, priority, deadline, status, splittable, completed_at, created_at",
        )
        .eq("user_id", user.id)
        .in("status", ["backlog", "scheduled"])
        .order("created_at"),
      supabase
        .from("blocks")
        .select(
          "id, name, color, default_minutes, default_category_id, preferred_daypart, archived, block_items(id, block_id, position, label, estimated_minutes, category_id)",
        )
        .eq("user_id", user.id)
        .eq("archived", false)
        .order("name"),
      // Filtered by time range rather than week_id so blocks that were dragged
      // across a week boundary still show up where they actually sit.
      supabase
        .from("scheduled_blocks")
        .select(
          "id, week_id, starts_at, ends_at, description, category_id, source_block_id, status, actual_minutes, scheduled_block_tasks(task_id, planned_minutes, tasks(id, description, category_id, estimated_minutes))",
        )
        .eq("user_id", user.id)
        .gte("starts_at", rangeStart)
        .lt("starts_at", rangeEnd)
        .order("starts_at"),
      supabase
        .from("objectives")
        .select("id, week_id, title, category_id, target_minutes, done, position")
        .eq("week_id", week.id)
        .order("position"),
      // The mirror of what Google says you are already committed to. Read-only,
      // and fetched for the same window as the grid.
      supabase
        .from("external_events")
        .select(
          "calendar_source_id, external_event_id, title, starts_at, ends_at, all_day, status, transparency, attendee_response",
        )
        .eq("user_id", user.id)
        .lt("starts_at", rangeEnd)
        .gt("ends_at", rangeStart)
        .order("starts_at"),
      supabase
        .from("calendar_sources")
        .select(
          "id, provider, external_id, display_name, color, category_id, enabled, include_all_day, include_free, include_declined, position",
        )
        .eq("user_id", user.id)
        .order("position"),
      supabase
        .from("google_accounts")
        .select(
          "google_email, connected_at, disconnected_at, last_error, last_error_at",
        )
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase
        .from("google_sync_state")
        .select("google_calendar_id, last_synced_at")
        .eq("user_id", user.id),
    ]);

  // Calendar errors are deliberately excluded: a broken integration degrades the
  // planner, it does not replace it with an error page.
  const error =
    categoriesRes.error ??
    tasksRes.error ??
    blocksRes.error ??
    scheduledRes.error ??
    objectivesRes.error;

  if (error) {
    return (
      <main className="mx-auto max-w-lg px-6 py-20 text-sm">
        <h1 className="font-medium">Could not load the week</h1>
        <p className="mt-2 text-muted">{error.message}</p>
        <p className="mt-4 text-muted">
          If this is a fresh project, run the migration in{" "}
          <code>supabase/migrations</code> first.
        </p>
      </main>
    );
  }

  // The weakest link decides how fresh the picture is, so report the oldest.
  const syncTimes = ((syncRes.data ?? []) as { last_synced_at: string | null }[]).map(
    (row) => row.last_synced_at,
  );
  const oldestSyncAt = syncTimes.includes(null)
    ? null
    : syncTimes.sort()[0] ?? null;

  return (
    <WeekPlanner
      weekStart={toISODate(weekStartDate)}
      week={week}
      categories={(categoriesRes.data ?? []) as Category[]}
      tasks={(tasksRes.data ?? []) as Task[]}
      blocks={(blocksRes.data ?? []) as unknown as Block[]}
      scheduled={(scheduledRes.data ?? []) as unknown as ScheduledBlock[]}
      objectives={(objectivesRes.data ?? []) as Objective[]}
      externalEvents={(externalRes.data ?? []) as ExternalEvent[]}
      calendarSources={(sourcesRes.data ?? []) as CalendarSource[]}
      googleAccount={(googleRes.data ?? null) as GoogleAccount | null}
      oldestSyncAt={oldestSyncAt}
    />
  );
}
