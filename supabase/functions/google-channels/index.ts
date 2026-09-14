import { adminClient, isServiceRole, json, readRefreshToken } from "../_shared/db.ts";
import { accessTokenFrom, stopChannel, watchCalendar } from "../_shared/google.ts";

const RENEW_WITHIN_MS = 48 * 60 * 60 * 1000;

/**
 * Creates and renews Google push channels. Service-role only; run daily by cron
 * and once after a successful connect.
 *
 * Channel lifetimes are set by Google, not by us, and the ceiling is not a
 * documented constant — so nothing here assumes a TTL. The `expiration` Google
 * returns is stored and drives renewal.
 */
Deno.serve(async (request) => {
  if (!isServiceRole(request)) return json({ error: "Forbidden" }, 403);

  const webhookUrl = Deno.env.get("GOOGLE_WEBHOOK_URL");
  if (!webhookUrl) return json({ error: "GOOGLE_WEBHOOK_URL is not set" }, 500);

  const admin = adminClient();

  const { data: accounts, error } = await admin
    .from("google_accounts")
    .select("user_id, refresh_token_secret, busy_calendar_ids")
    .is("disconnected_at", null);
  if (error) return json({ error: error.message }, 500);

  const actions: { calendar: string; action: string; error?: string }[] = [];

  for (const account of accounts ?? []) {
    let accessToken: string;
    try {
      accessToken = await accessTokenFrom(
        await readRefreshToken(admin, account.refresh_token_secret),
      );
    } catch (e) {
      actions.push({
        calendar: "-",
        action: "token",
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    const { data: existing } = await admin
      .from("google_sync_channels")
      .select("id, google_calendar_id, channel_id, resource_id, expiration")
      .eq("user_id", account.user_id);

    const byCalendar = new Map(
      (existing ?? []).map((c) => [c.google_calendar_id as string, c]),
    );

    for (const calendarId of account.busy_calendar_ids ?? []) {
      const current = byCalendar.get(calendarId);
      const expiresSoon =
        !current ||
        new Date(current.expiration).getTime() - Date.now() < RENEW_WITHIN_MS;
      if (!expiresSoon) continue;

      try {
        const channelId = crypto.randomUUID();
        const channelToken = crypto.randomUUID();

        // New channel first, old one after: overlapping channels only cause a
        // duplicate ping, whereas stopping first leaves a window with no
        // notifications at all.
        const watched = await watchCalendar(accessToken, calendarId, {
          id: channelId,
          address: webhookUrl,
          token: channelToken,
        });

        await admin.from("google_sync_channels").insert({
          user_id: account.user_id,
          google_calendar_id: calendarId,
          channel_id: channelId,
          resource_id: watched.resourceId,
          channel_token: channelToken,
          expiration: watched.expiration
            ? new Date(Number(watched.expiration)).toISOString()
            : new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
        });

        if (current) {
          await stopChannel(accessToken, current.channel_id, current.resource_id).catch(
            () => {},
          );
          await admin.from("google_sync_channels").delete().eq("id", current.id);
        }

        actions.push({ calendar: calendarId, action: current ? "renewed" : "created" });
      } catch (e) {
        actions.push({
          calendar: calendarId,
          action: "failed",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Channels for calendars the user has since unticked.
    for (const [calendarId, channel] of byCalendar) {
      if ((account.busy_calendar_ids ?? []).includes(calendarId)) continue;
      await stopChannel(accessToken, channel.channel_id, channel.resource_id).catch(
        () => {},
      );
      await admin.from("google_sync_channels").delete().eq("id", channel.id);
      actions.push({ calendar: calendarId, action: "stopped" });
    }
  }

  return json({ ok: true, actions });
});
