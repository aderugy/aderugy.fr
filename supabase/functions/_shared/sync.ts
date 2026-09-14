import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  GrantRevokedError,
  SyncTokenExpiredError,
  accessTokenFrom,
  listEvents,
} from "./google.ts";
import { mapPage, type GoogleEvent } from "./events.ts";
import { readRefreshToken } from "./db.ts";

export type SyncOutcome =
  | { status: "skipped"; reason: string }
  | { status: "synced"; upserted: number; deleted: number; full: boolean }
  | { status: "failed"; error: string };

/**
 * Incremental sync of one calendar, idempotent and safe to run concurrently.
 *
 * The lease is what makes concurrency safe: a webhook and an on-load sync
 * arriving together must not interleave, because the loser would persist a
 * syncToken that does not account for the rows the winner wrote.
 */
export async function syncCalendar(
  admin: SupabaseClient,
  userId: string,
  calendarId: string,
): Promise<SyncOutcome> {
  const { data: claimed, error: claimError } = await admin.rpc("claim_calendar_sync", {
    p_user: userId,
    p_calendar: calendarId,
  });
  if (claimError) return { status: "failed", error: claimError.message };
  if (!claimed) return { status: "skipped", reason: "already syncing" };

  try {
    const { data: account, error: accountError } = await admin
      .from("google_accounts")
      .select("refresh_token_secret, disconnected_at")
      .eq("user_id", userId)
      .single();
    if (accountError) throw accountError;
    if (account.disconnected_at) return { status: "skipped", reason: "disconnected" };

    const refreshToken = await readRefreshToken(admin, account.refresh_token_secret);
    const accessToken = await accessTokenFrom(refreshToken);

    const { data: state } = await admin
      .from("google_sync_state")
      .select("sync_token, full_resync_needed")
      .eq("user_id", userId)
      .eq("google_calendar_id", calendarId)
      .single();

    let syncToken: string | null = state?.full_resync_needed ? null : (state?.sync_token ?? null);
    let full = !syncToken;

    const result = await drain(admin, userId, calendarId, accessToken, syncToken);

    if (result.expired) {
      // The token is gone: everything we hold for this calendar may be stale,
      // including deletions we never saw. Wipe and rebuild rather than merge.
      await admin
        .from("external_events")
        .delete()
        .eq("user_id", userId)
        .eq("google_calendar_id", calendarId);

      syncToken = null;
      full = true;
      const rebuilt = await drain(admin, userId, calendarId, accessToken, null);
      Object.assign(result, rebuilt);
    }

    // The token is written only after its rows are committed. Storing it first
    // and failing afterwards would lose those changes permanently.
    await admin
      .from("google_sync_state")
      .update({
        sync_token: result.nextSyncToken,
        last_synced_at: new Date().toISOString(),
        full_resync_needed: false,
        last_error: null,
        last_error_at: null,
      })
      .eq("user_id", userId)
      .eq("google_calendar_id", calendarId);

    return {
      status: "synced",
      upserted: result.upserted,
      deleted: result.deleted,
      full,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof GrantRevokedError) {
      // Not retryable. Mark it and let the UI say so rather than looping.
      await admin
        .from("google_accounts")
        .update({
          disconnected_at: new Date().toISOString(),
          last_error: "Google access was revoked. Reconnect to resume syncing.",
          last_error_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    }

    await admin
      .from("google_sync_state")
      .update({ last_error: message, last_error_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("google_calendar_id", calendarId);

    return { status: "failed", error: message };
  } finally {
    await admin.rpc("release_calendar_sync", { p_user: userId, p_calendar: calendarId });
  }
}

async function drain(
  admin: SupabaseClient,
  userId: string,
  calendarId: string,
  accessToken: string,
  syncToken: string | null,
) {
  let pageToken: string | null = null;
  let nextSyncToken: string | null = null;
  let upserted = 0;
  let deleted = 0;

  do {
    let page;
    try {
      page = await listEvents(accessToken, calendarId, { syncToken, pageToken });
    } catch (error) {
      if (error instanceof SyncTokenExpiredError) {
        return { expired: true, nextSyncToken: null, upserted, deleted };
      }
      throw error;
    }

    const { upserts, deletes } = mapPage(
      userId,
      calendarId,
      (page.items ?? []) as GoogleEvent[],
    );

    if (upserts.length) {
      const { error } = await admin
        .from("external_events")
        .upsert(upserts, {
          onConflict: "user_id,google_calendar_id,google_event_id",
        });
      if (error) throw error;
      upserted += upserts.length;
    }

    if (deletes.length) {
      const { error } = await admin
        .from("external_events")
        .delete()
        .eq("user_id", userId)
        .eq("google_calendar_id", calendarId)
        .in("google_event_id", deletes);
      if (error) throw error;
      deleted += deletes.length;
    }

    pageToken = page.nextPageToken ?? null;
    nextSyncToken = page.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  return { expired: false, nextSyncToken, upserted, deleted };
}

/** Sync every calendar the user has marked as busy-relevant. */
export async function syncAllCalendars(admin: SupabaseClient, userId: string) {
  const { data: rows } = await admin
    .from("google_sync_state")
    .select("google_calendar_id")
    .eq("user_id", userId);

  const outcomes: Record<string, SyncOutcome> = {};
  for (const row of rows ?? []) {
    outcomes[row.google_calendar_id] = await syncCalendar(
      admin,
      userId,
      row.google_calendar_id,
    );
  }
  return outcomes;
}
