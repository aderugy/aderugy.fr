import "server-only";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Ask Supabase to push this user's pending blocks to Google, after the response.
 *
 * The action has already written the block and the database has already marked
 * it pending (a trigger does that, so no write path can forget). This is only
 * the nudge that makes it show up in Google within seconds rather than at the
 * next cron minute — so it never delays the response, and a failure here costs
 * nothing but that minute.
 *
 * The token is read now, while the request is live; the call itself runs in
 * `after`, once the user already has their answer. For someone with push off,
 * the Edge Function declines in one query.
 */
export async function queuePush(supabase: SupabaseClient) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return;

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return;
  const token = session.access_token;

  after(async () => {
    try {
      await fetch(`${base}/functions/v1/google-push`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    } catch {
      // The cron sweep picks it up within a minute.
    }
  });
}
