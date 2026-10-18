import { redirect } from "next/navigation";
import { createClient, userFromClaims } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { BacklogView } from "@/components/agenda/backlog/BacklogView";
import type { BacklogTask } from "@/components/agenda/backlog/shared";
import { fmtWhen, localDate } from "@/lib/agenda/zoned";
import { LISTED_TASKS } from "@/server/agenda/tasks";
import { sessionSummaries } from "@/server/weeks";
import type { Category, Task } from "@/lib/types";

export const metadata = { title: "Backlog — Agenda" };

const APP_TIMEZONE = process.env.NEXT_PUBLIC_APP_TIMEZONE ?? "Europe/Paris";

export default async function BacklogPage() {
  const supabase = await createClient();
  const user = await userFromClaims(supabase);
  // Defence in depth: the proxy already gates this, but a bypassed or
  // misconfigured proxy must not render a blank page.
  if (!user) redirect(LOGIN_PATH);

  const [categoriesRes, tasksRes] = await Promise.all([
    supabase
      .from("categories")
      .select("id, parent_id, name, color, position, archived")
      .eq("user_id", user.id)
      .eq("archived", false)
      .order("position"),
    supabase
      .from("tasks")
      .select(
        "id, category_id, description, notes, estimated_minutes, priority, deadline, status, splittable, ad_hoc, completed_at, created_at",
      )
      .eq("user_id", user.id)
      .in("status", ["backlog", "scheduled"])
      // An interview's own task is the interview; it lives on /jobs.
      .or(LISTED_TASKS)
      .order("created_at", { ascending: false }),
  ]);

  const error = categoriesRes.error ?? tasksRes.error;
  if (error) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
        <h1 className="font-medium">Could not load the backlog</h1>
        <p className="mt-2 text-muted">{error.message}</p>
      </main>
    );
  }

  const categories = (categoriesRes.data ?? []) as Category[];
  const rows = (tasksRes.data ?? []) as Task[];
  const now = new Date().getTime();

  // Each task's slots: the planned one (when, and whether its time is
  // already over) and how often it was skipped before.
  const sessions = await sessionSummaries(
    supabase,
    rows.map((t) => t.id),
  );

  const tasks: BacklogTask[] = rows.map((t) => {
    const s = sessions.get(t.id);
    const at = t.status === "scheduled" ? (s?.plannedStarts ?? null) : null;
    return {
      ...t,
      scheduled_at: at,
      scheduled_label: at ? fmtWhen(at, APP_TIMEZONE) : null,
      session_id: s?.plannedId ?? null,
      missed: Boolean(s?.plannedEnds && Date.parse(s.plannedEnds) <= now),
      skipped_count: s?.skippedCount ?? 0,
      last_skipped_label: s?.lastSkipped ? fmtWhen(s.lastSkipped, APP_TIMEZONE) : null,
    };
  });

  return (
    <BacklogView
      categories={categories}
      tasks={tasks}
      today={localDate(now, APP_TIMEZONE)}
    />
  );
}
