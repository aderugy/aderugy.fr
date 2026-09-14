import { adminClient, callerFromRequest, json, storeRefreshToken } from "../_shared/db.ts";
import { exchangeCode, listCalendars } from "../_shared/google.ts";
import { syncAllCalendars } from "../_shared/sync.ts";

/**
 * Completes the Calendar consent.
 *
 * The app never sees the Google client secret or the refresh token: it forwards
 * the authorization code here with the user's Supabase JWT, and gets back the
 * list of calendars.
 */
Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const user = await callerFromRequest(request);
  if (!user) return json({ error: "Not authenticated" }, 401);

  let body: { action?: "connect" | "disconnect"; code?: string; redirectUri?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const admin = adminClient();

  if (body.action === "disconnect") {
    // Stopping the channels and dropping the Vault secret both need the service
    // role, so disconnect cannot be a plain SQL call from the app.
    const { data: account } = await admin
      .from("google_accounts")
      .select("refresh_token_secret")
      .eq("user_id", user.id)
      .maybeSingle();

    await admin.from("external_events").delete().eq("user_id", user.id);
    await admin.from("google_sync_channels").delete().eq("user_id", user.id);
    await admin.from("google_sync_state").delete().eq("user_id", user.id);
    await admin.from("google_accounts").delete().eq("user_id", user.id);

    if (account?.refresh_token_secret) {
      await admin.rpc("vault_forget", { p_id: account.refresh_token_secret });
    }
    return json({ ok: true });
  }

  if (!body.code || !body.redirectUri) {
    return json({ error: "code and redirectUri are required" }, 400);
  }

  try {
    const token = await exchangeCode(body.code, body.redirectUri);
    const secretId = await storeRefreshToken(admin, user.id, token.refresh_token!);
    const calendars = await listCalendars(token.access_token);

    const primary = calendars.find((c) => c.primary)?.id ?? calendars[0]?.id;

    const { error: accountError } = await admin.from("google_accounts").upsert({
      user_id: user.id,
      google_email: user.email ?? null,
      refresh_token_secret: secretId,
      scopes: token.scope.split(" "),
      busy_calendar_ids: primary ? [primary] : [],
      connected_at: new Date().toISOString(),
      disconnected_at: null,
      last_error: null,
      last_error_at: null,
    });
    if (accountError) throw accountError;

    // A sync-state row per calendar, so the user can toggle any of them on later
    // without a second consent. Existing rows keep their sync tokens.
    const { error: stateError } = await admin.from("google_sync_state").upsert(
      calendars.map((c) => ({
        user_id: user.id,
        google_calendar_id: c.id,
        summary: c.summary ?? null,
      })),
      { onConflict: "user_id,google_calendar_id", ignoreDuplicates: true },
    );
    if (stateError) throw stateError;

    // First fill, so the planner is useful immediately rather than after the
    // next cron tick.
    const outcomes = await syncAllCalendars(admin, user.id);

    return json({ ok: true, calendars, outcomes });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, 400);
  }
});
