import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { adminClient, callerFromRequest, isServiceRole, json } from "../_shared/db.ts";
import type { PushSession } from "../_shared/push-events.ts";
import { reminderFor, TEST_REMINDER, type ReminderPayload } from "../_shared/reminders.ts";
import { sendPush, type VapidKeys } from "../_shared/webpush.ts";

/**
 * Notifications on Arthur's devices (Web Push). Not to be confused with
 * `google-push`, which writes sessions to Google Calendar.
 *
 * - The service-role key with `{ due: true }` ⇒ the cron sweep: one reminder
 *   per planned session, `lead_minutes` before it starts, to every device.
 * - A user JWT with `{ action: "test" }` ⇒ a test notification to the caller's
 *   own devices, from the settings page.
 */

type Subscription = { id: string; endpoint: string; p256dh: string; auth: string };

type DueRow = { session_id: string; user_id: string; starts_at: string; ends_at: string };

type SessionRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  tasks: { description: string | null; notes: string | null; category_id: string | null } | null;
};

function vapidKeys(): VapidKeys {
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT");
  if (!publicKey || !privateKey || !subject) {
    throw new Error("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set");
  }
  return { publicKey, privateKey, subject };
}

/**
 * Sends to every device of one user. Dead subscriptions (the browser dropped
 * them, or the app was uninstalled) are deleted on the spot. Returns how many
 * devices took it, and whether any failure is worth retrying.
 */
async function sendToUser(
  admin: SupabaseClient,
  vapid: VapidKeys,
  subs: Subscription[],
  payload: ReminderPayload,
  ttl: number,
) {
  let delivered = 0;
  let retryable = 0;
  await Promise.all(
    subs.map(async (sub) => {
      let result;
      try {
        result = await sendPush(sub, payload, vapid, {
          ttl,
          urgency: "high",
          // Topics are ≤ 32 base64url chars: the session id without dashes fits.
          topic: payload.tag.replace(/^(session|block)-/, "").replaceAll("-", "").slice(0, 32),
        });
      } catch (error) {
        result = { ok: false as const, gone: false, status: 0, message: String(error) };
      }

      if (result.ok) {
        delivered++;
        await admin
          .from("push_subscriptions")
          .update({ last_success_at: new Date().toISOString(), last_error: null })
          .eq("id", sub.id);
      } else if (result.gone) {
        await admin.from("push_subscriptions").delete().eq("id", sub.id);
      } else {
        retryable++;
        await admin
          .from("push_subscriptions")
          .update({
            last_error: `${result.status}: ${result.message}`,
            last_error_at: new Date().toISOString(),
          })
          .eq("id", sub.id);
      }
    }),
  );
  return { delivered, retryable };
}

async function subscriptionsOf(admin: SupabaseClient, userIds: string[]) {
  const { data, error } = await admin
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth")
    .in("user_id", userIds);
  if (error) throw error;
  const byUser = new Map<string, Subscription[]>();
  for (const row of data ?? []) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }
  return byUser;
}

async function sweep(admin: SupabaseClient, vapid: VapidKeys) {
  const { data: due, error } = await admin.rpc("sessions_due_for_reminder", {});
  if (error) throw error;
  const rows = (due ?? []) as DueRow[];
  if (rows.length === 0) return { sent: 0, results: [] };

  const ids = rows.map((r) => r.session_id);
  const userIds = [...new Set(rows.map((r) => r.user_id))];

  // Claim first, so a sweep overlapping this one does not ring twice. A
  // reminder that reached no device is released below for the next minute.
  const { error: claimError } = await admin.from("session_reminders_sent").upsert(
    rows.map((r) => ({
      session_id: r.session_id,
      user_id: r.user_id,
      starts_at: r.starts_at,
      sent_at: new Date().toISOString(),
    })),
    { onConflict: "session_id" },
  );
  if (claimError) throw claimError;

  const [{ data: sessions, error: sessionsError }, { data: categories }, subs] = await Promise.all([
    admin
      .from("task_sessions")
      .select("id, starts_at, ends_at, status, tasks(description, notes, category_id)")
      .in("id", ids),
    admin.from("categories").select("id, name").in("user_id", userIds),
    subscriptionsOf(admin, userIds),
  ]);
  if (sessionsError) throw sessionsError;

  const categoryName = new Map((categories ?? []).map((c) => [c.id as string, c.name as string]));
  const byId = new Map(((sessions ?? []) as unknown as SessionRow[]).map((s) => [s.id, s]));
  const timeZone = Deno.env.get("APP_TIMEZONE") ?? "Europe/Paris";
  const now = new Date();

  const results = [];
  for (const due of rows) {
    const row = byId.get(due.session_id);
    if (!row) continue;

    const session: PushSession = {
      id: row.id,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      status: row.status,
      categoryName: row.tasks?.category_id ? (categoryName.get(row.tasks.category_id) ?? null) : null,
      description: row.tasks?.description ?? null,
      notes: row.tasks?.notes ?? null,
    };

    // Useless once the slot has started: let the push service drop it then.
    const ttl = Math.max(60, Math.floor((new Date(session.starts_at).getTime() - now.getTime()) / 1000));
    const outcome = await sendToUser(
      admin,
      vapid,
      subs.get(due.user_id) ?? [],
      reminderFor(session, { timeZone, now }),
      ttl,
    );

    if (outcome.delivered === 0 && outcome.retryable > 0) {
      await admin.from("session_reminders_sent").delete().eq("session_id", session.id);
    }
    results.push({ session: session.id, ...outcome });
  }
  return { sent: results.filter((r) => r.delivered > 0).length, results };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { due?: boolean; action?: "test" } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body.
  }

  let vapid: VapidKeys;
  try {
    vapid = vapidKeys();
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }

  const admin = adminClient();

  if (isServiceRole(request) && body.due) {
    try {
      return json({ ok: true, ...(await sweep(admin, vapid)) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  const user = await callerFromRequest(request);
  if (!user) return json({ error: "Not authenticated" }, 401);

  if (body.action === "test") {
    const subs = (await subscriptionsOf(admin, [user.id])).get(user.id) ?? [];
    if (subs.length === 0) return json({ error: "No device is subscribed yet" }, 400);
    const outcome = await sendToUser(admin, vapid, subs, TEST_REMINDER, 300);
    return json({ ok: true, devices: subs.length, ...outcome });
  }

  return json({ error: "Unknown action" }, 400);
});
