import {
  adminClient,
  callerFromRequest,
  json,
  readRefreshToken,
  storeRefreshToken,
} from "../_shared/db.ts";
import {
  accessTokenFrom,
  deletePushCalendar,
  exchangeCode,
  listCalendars,
} from "../_shared/google.ts";
import { WRITE_SCOPE } from "../_shared/push.ts";
import { syncAllCalendars } from "../_shared/sync.ts";

/** Same palette the category tree uses, so a week reads as one system. */
const PALETTE = [
  "#3b5bdb", "#0ca678", "#e8590c", "#ae3ec9", "#1c7ed6",
  "#2f9e44", "#e03131", "#f08c00", "#0c8599", "#64748b",
];

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
      .select("refresh_token_secret, scopes, push_calendar_id")
      .eq("user_id", user.id)
      .maybeSingle();

    // The Agenda calendar is the app's own; leaving it behind would leave a
    // frozen copy of the plan in Google that nothing updates any more. Best
    // effort — a revoked grant cannot delete it, and must not block leaving.
    if (account?.push_calendar_id && (account.scopes ?? []).includes(WRITE_SCOPE)) {
      try {
        const token = await accessTokenFrom(
          await readRefreshToken(admin, account.refresh_token_secret),
        );
        await deletePushCalendar(token, account.push_calendar_id);
      } catch {
        // Nothing useful to do with it; the user can delete it in Google.
      }
    }

    // calendar_sources cascades to external_events, so the mirror goes with it.
    await admin.from("calendar_sources").delete().eq("user_id", user.id);
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

    // The calendar the app writes blocks into shows up in Google's list like
    // any other. It is never a source: mirroring it would draw every block twice.
    const { data: existing } = await admin
      .from("google_accounts")
      .select("push_calendar_id")
      .eq("user_id", user.id)
      .maybeSingle();
    const calendars = (await listCalendars(token.access_token)).filter(
      (c) => c.id !== existing?.push_calendar_id,
    );

    const { error: accountError } = await admin.from("google_accounts").upsert({
      user_id: user.id,
      google_email: user.email ?? null,
      refresh_token_secret: secretId,
      scopes: token.scope.split(" "),
      connected_at: new Date().toISOString(),
      disconnected_at: null,
      last_error: null,
      last_error_at: null,
    });
    if (accountError) throw accountError;

    // Every calendar is discovered as a *disabled* source, named as Google
    // names it. Enabling is where the user renames it and says what its hours
    // count as — decisions that only mean something once they pick a calendar.
    const { error: sourcesError } = await admin.from("calendar_sources").upsert(
      calendars.map((c, i) => ({
        user_id: user.id,
        provider: "google",
        external_id: c.id,
        display_name: (c.summary ?? c.id).slice(0, 60),
        color: PALETTE[i % PALETTE.length],
        position: i,
      })),
      { onConflict: "user_id,provider,external_id", ignoreDuplicates: true },
    );
    if (sourcesError) throw sourcesError;

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
