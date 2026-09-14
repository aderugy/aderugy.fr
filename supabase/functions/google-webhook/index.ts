import { adminClient } from "../_shared/db.ts";
import { syncCalendar } from "../_shared/sync.ts";

/**
 * Google's push endpoint. Public by necessity — Google cannot present a Supabase
 * JWT — so `verify_jwt = false` in config.toml and the channel token is what
 * authenticates the ping.
 *
 * The notification carries no event data. It only says "something changed on
 * this channel"; the syncToken is the sole authority on what.
 */
Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const channelId = request.headers.get("X-Goog-Channel-ID");
  const channelToken = request.headers.get("X-Goog-Channel-Token");
  const resourceState = request.headers.get("X-Goog-Resource-State");

  // Google retries anything that is not 2xx. An unrecognised or unauthenticated
  // ping is not our problem to retry, so acknowledge and drop it.
  if (!channelId || !channelToken) return new Response(null, { status: 204 });

  // Sent once when the channel is created. Nothing has changed yet.
  if (resourceState === "sync") return new Response(null, { status: 204 });

  const admin = adminClient();

  const { data: channel } = await admin
    .from("google_sync_channels")
    .select("user_id, google_calendar_id, channel_token")
    .eq("channel_id", channelId)
    .maybeSingle();

  if (!channel || channel.channel_token !== channelToken) {
    return new Response(null, { status: 204 });
  }

  // Acknowledge first, sync after. A slow handler gets retried, and every retry
  // is duplicate work; the lease inside syncCalendar collapses any overlap.
  const work = syncCalendar(admin, channel.user_id, channel.google_calendar_id)
    .catch((error) => console.error("webhook sync failed", error));

  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(work);
  else await work;

  return new Response(null, { status: 204 });
});
