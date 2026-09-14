import { adminClient, callerFromRequest, isServiceRole, json } from "../_shared/db.ts";
import { syncAllCalendars, syncCalendar } from "../_shared/sync.ts";

/**
 * Two callers, two shapes:
 *
 * - A user JWT ⇒ "sync my calendars now" (the on-load freshness layer).
 * - The service-role key ⇒ `{ due: true }`, the cron sweep over every calendar
 *   that is overdue or was flagged by a webhook.
 */
Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = adminClient();

  let body: { due?: boolean; calendarId?: string; maxAgeSeconds?: number } = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is a valid "sync mine".
  }

  if (isServiceRole(request) && body.due) {
    const { data: due, error } = await admin.rpc("calendars_due_for_sync", {
      p_max_age_seconds: body.maxAgeSeconds ?? 300,
    });
    if (error) return json({ error: error.message }, 500);

    const results = [];
    for (const row of (due ?? []) as { user_id: string; google_calendar_id: string }[]) {
      results.push({
        calendar: row.google_calendar_id,
        outcome: await syncCalendar(admin, row.user_id, row.google_calendar_id),
      });
    }
    return json({ ok: true, swept: results.length, results });
  }

  const user = await callerFromRequest(request);
  if (!user) return json({ error: "Not authenticated" }, 401);

  if (body.calendarId) {
    return json({ ok: true, outcome: await syncCalendar(admin, user.id, body.calendarId) });
  }
  return json({ ok: true, outcomes: await syncAllCalendars(admin, user.id) });
});
