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
  | {
      status: "synced";
      upserted: number;
      deleted: number;
      /** Events removed upstream after they had already happened, kept here. */
      archived: number;
      full: boolean;
    }
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

    // Every mirrored row hangs off a source, so resolve it before writing any.
    const { data: source, error: sourceError } = await admin
      .from("calendar_sources")
      .select("id")
      .eq("user_id", userId)
      .eq("provider", "google")
      .eq("external_id", calendarId)
      .single();
    if (sourceError) throw sourceError;

    const { data: state } = await admin
      .from("google_sync_state")
      .select("sync_token, full_resync_needed")
      .eq("user_id", userId)
      .eq("google_calendar_id", calendarId)
      .single();

    let syncToken: string | null = state?.full_resync_needed ? null : (state?.sync_token ?? null);
    let full = !syncToken;

    const result = await drain(admin, userId, calendarId, source.id, accessToken, syncToken);

    if (result.expired) {
      // The token is gone: everything we hold for this calendar may be stale,
      // including deletions we never saw. Wipe and rebuild rather than merge —
      // but only the part of the week that is still ahead. A past event the
      // provider has since dropped would not come back in the rebuild, so
      // discarding it here would lose it for good; archive it instead. The
      // rebuild clears the flag again on everything the provider still knows.
      const wipedAt = new Date().toISOString();

      const { error: archiveError } = await admin
        .from("external_events")
        .update({ archived_at: wipedAt })
        .eq("user_id", userId)
        .eq("calendar_source_id", source.id)
        .is("archived_at", null)
        .lte("ends_at", wipedAt);
      if (archiveError) throw archiveError;

      const { error: wipeError } = await admin
        .from("external_events")
        .delete()
        .eq("user_id", userId)
        .eq("calendar_source_id", source.id)
        .is("archived_at", null)
        .gt("ends_at", wipedAt);
      if (wipeError) throw wipeError;

      syncToken = null;
      full = true;
      const rebuilt = await drain(admin, userId, calendarId, source.id, accessToken, null);
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
      archived: result.archived,
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
  sourceId: string,
  accessToken: string,
  syncToken: string | null,
) {
  let pageToken: string | null = null;
  let nextSyncToken: string | null = null;
  let upserted = 0;
  let deleted = 0;
  let archived = 0;

  do {
    let page;
    try {
      page = await listEvents(accessToken, calendarId, { syncToken, pageToken });
    } catch (error) {
      if (error instanceof SyncTokenExpiredError) {
        return { expired: true, nextSyncToken: null, upserted, deleted, archived };
      }
      throw error;
    }

    const { upserts, deletes } = mapPage(
      userId,
      sourceId,
      (page.items ?? []) as GoogleEvent[],
    );

    if (upserts.length) {
      const { error } = await admin
        .from("external_events")
        .upsert(upserts, {
          onConflict: "user_id,calendar_source_id,external_event_id",
        });
      if (error) throw error;
      upserted += upserts.length;
    }

    if (deletes.length) {
      const outcome = await removeOrArchive(admin, userId, sourceId, deletes);
      deleted += outcome.deleted;
      archived += outcome.archived;
    }

    pageToken = page.nextPageToken ?? null;
    nextSyncToken = page.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  return { expired: false, nextSyncToken, upserted, deleted, archived };
}

/**
 * A deletion from the provider is obeyed only while the event is still ahead.
 *
 * One connected calendar drops an event the moment it is over. Mirroring that
 * would rewrite weeks already lived — their hours would vanish from the grid
 * and from every total computed off it. So an event that has already ended is
 * archived rather than removed: it keeps showing, it keeps counting, and the
 * only hand that can delete it is the owner's. An event still to come has
 * genuinely been cancelled, and goes.
 *
 * Archived rows are excluded from both statements, so this is idempotent: a
 * second cancellation for the same event changes nothing, and the original
 * archive time survives.
 */
async function removeOrArchive(
  admin: SupabaseClient,
  userId: string,
  sourceId: string,
  eventIds: string[],
) {
  const now = new Date().toISOString();

  const { data: archivedRows, error: archiveError } = await admin
    .from("external_events")
    .update({ archived_at: now })
    .eq("user_id", userId)
    .eq("calendar_source_id", sourceId)
    .in("external_event_id", eventIds)
    .is("archived_at", null)
    .lte("ends_at", now)
    .select("external_event_id");
  if (archiveError) throw archiveError;

  const { data: deletedRows, error: deleteError } = await admin
    .from("external_events")
    .delete()
    .eq("user_id", userId)
    .eq("calendar_source_id", sourceId)
    .in("external_event_id", eventIds)
    .is("archived_at", null)
    .gt("ends_at", now)
    .select("external_event_id");
  if (deleteError) throw deleteError;

  return {
    archived: archivedRows?.length ?? 0,
    deleted: deletedRows?.length ?? 0,
  };
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
