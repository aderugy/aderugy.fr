import { adminClient, callerFromRequest, isServiceRole, json } from "../_shared/db.ts";
import { disablePush, enablePush, pushUser } from "../_shared/push.ts";

/**
 * Writes planned blocks to the app's own "Agenda" calendar in Google.
 *
 * - The service-role key with `{ due: true }` ⇒ the cron sweep: every user with
 *   pending blocks or deletions to carry out.
 * - A user JWT ⇒ `{ action: "enable" | "disable" }` from the settings page, or
 *   an empty body — "push mine now", fired by the app after each edit.
 */
Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = adminClient();

  let body: { due?: boolean; action?: "enable" | "disable" } = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is a valid "push mine".
  }

  if (isServiceRole(request) && body.due) {
    const { data: due, error } = await admin.rpc("users_due_for_push", {});
    if (error) return json({ error: error.message }, 500);

    const results = [];
    for (const row of (due ?? []) as { user_id: string }[]) {
      results.push({ user: row.user_id, outcome: await pushUser(admin, row.user_id) });
    }
    return json({ ok: true, swept: results.length, results });
  }

  const user = await callerFromRequest(request);
  if (!user) return json({ error: "Not authenticated" }, 401);

  try {
    if (body.action === "enable") {
      return json({ ok: true, outcome: await enablePush(admin, user.id) });
    }
    if (body.action === "disable") {
      return json({ ok: true, ...(await disablePush(admin, user.id)) });
    }
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }

  // The app fires this after every edit and does not wait for it, so answer at
  // once and push in the background — the same trick the webhook uses.
  const work = pushUser(admin, user.id);
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) {
    runtime.waitUntil(work);
    return json({ ok: true, queued: true }, 202);
  }
  return json({ ok: true, outcome: await work });
});
