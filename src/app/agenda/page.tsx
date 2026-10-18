import { redirect } from "next/navigation";
import { createClient, userFromClaims } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { addDays, fromISODate, isoWeekStartInTimeZone, toISODate } from "@/lib/time";
import { WeekPlanner } from "@/components/agenda/WeekPlanner";
import { withoutHidden } from "@/lib/external";
import { loadWeekPage } from "@/server/agenda/week-page";

export const metadata = { title: "Week — Agenda" };

const APP_TIMEZONE = process.env.NEXT_PUBLIC_APP_TIMEZONE ?? "Europe/Paris";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function AgendaPage({ searchParams }: PageProps<"/agenda">) {
  const params = await searchParams;
  const requested = typeof params.w === "string" && ISO_DATE.test(params.w) ? params.w : null;
  const weekStart = requested ?? isoWeekStartInTimeZone(new Date(), APP_TIMEZONE);

  const supabase = await createClient();
  const user = await userFromClaims(supabase);
  // Defence in depth: the proxy already gates this, but a bypassed or
  // misconfigured proxy must not render a blank page.
  if (!user) redirect(LOGIN_PATH);

  const weekStartDate = fromISODate(weekStart);
  const load = await loadWeekPage(supabase, user.id, {
    weekStart,
    rangeStart: addDays(weekStartDate, -1).toISOString(),
    rangeEnd: addDays(weekStartDate, 8).toISOString(),
  });

  if (!load.ok) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
        <h1 className="font-medium">Could not load the week</h1>
        <p className="mt-2 text-muted">{load.error}</p>
        <p className="mt-4 text-muted">
          If this is a fresh project, run the migration in{" "}
          <code>supabase/migrations</code> first.
        </p>
      </main>
    );
  }
  const w = load.data;

  // The weakest link decides how fresh the picture is, so report the oldest.
  const syncTimes = w.syncState.map((row) => row.last_synced_at);
  const oldestSyncAt = syncTimes.includes(null)
    ? null
    : syncTimes.sort()[0] ?? null;

  return (
    <WeekPlanner
      weekStart={toISODate(weekStartDate)}
      week={w.week}
      categories={w.categories}
      tasks={w.tasks}
      sessions={w.sessions}
      objectives={w.objectives}
      externalEvents={withoutHidden(w.externalEvents, w.hiddenEvents)}
      calendarSources={w.calendarSources}
      googleAccount={w.googleAccount}
      oldestSyncAt={oldestSyncAt}
    />
  );
}
