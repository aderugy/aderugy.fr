import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  GoogleApiError,
  GrantRevokedError,
  PushCalendarGoneError,
  accessTokenFrom,
  createPushCalendar,
  deletePushCalendar,
  deletePushEvent,
  putPushEvent,
} from "./google.ts";
import { eventFor, type PushBlock } from "./push-events.ts";
import { readRefreshToken } from "./db.ts";

export const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

const CALENDAR_NAME = "Agenda";
/** A block that has failed this many times waits for an edit to try again. */
const MAX_ATTEMPTS = 8;
const BATCH = 100;
/** Keeps one invocation well inside the Edge Function wall-clock limit. */
const MAX_OPERATIONS = 300;
const LEASE_SECONDS = 300;

export type PushOutcome =
  | { status: "skipped"; reason: string }
  | { status: "pushed"; upserted: number; deleted: number; failed: number; recreated: boolean }
  | { status: "failed"; error: string };

export class MissingWriteScopeError extends Error {
  constructor() {
    super(
      "Google has not granted write access to the Agenda calendar yet. Reconnect Google Calendar to allow it.",
    );
  }
}

type Account = {
  refresh_token_secret: string;
  scopes: string[] | null;
  push_enabled: boolean;
  push_calendar_id: string | null;
  disconnected_at: string | null;
};

async function loadAccount(admin: SupabaseClient, userId: string): Promise<Account> {
  const { data, error } = await admin
    .from("google_accounts")
    .select("refresh_token_secret, scopes, push_enabled, push_calendar_id, disconnected_at")
    .eq("user_id", userId)
    .single();
  if (error) throw error;
  return data as Account;
}

export async function writeAccessToken(admin: SupabaseClient, account: Account) {
  if (!(account.scopes ?? []).includes(WRITE_SCOPE)) throw new MissingWriteScopeError();
  return await accessTokenFrom(await readRefreshToken(admin, account.refresh_token_secret));
}

/**
 * Forget everything that was pushed: every block goes back in the queue with no
 * event id. Used when the calendar holding those events is gone.
 */
async function resetPushState(admin: SupabaseClient, userId: string) {
  const { error } = await admin
    .from("scheduled_blocks")
    .update({
      sync_state: "pending",
      google_event_id: null,
      google_synced_at: null,
      push_attempts: 0,
      push_error: null,
    })
    .eq("user_id", userId);
  if (error) throw error;

  await admin.from("google_push_tombstones").delete().eq("user_id", userId);
}

/**
 * The app's own calendar, created on first use.
 *
 * Also drops any `calendar_sources` row for it. A reconnect lists every
 * calendar Google knows, this one included, and mirroring it back into the
 * planner would draw every block twice.
 */
async function createCalendar(admin: SupabaseClient, userId: string, accessToken: string) {
  const timeZone = Deno.env.get("APP_TIMEZONE") ?? "Europe/Paris";
  const calendarId = await createPushCalendar(accessToken, CALENDAR_NAME, timeZone);

  const { error } = await admin
    .from("google_accounts")
    .update({ push_calendar_id: calendarId })
    .eq("user_id", userId);
  if (error) throw error;

  return calendarId;
}

export async function forgetPushCalendarAsSource(
  admin: SupabaseClient,
  userId: string,
  calendarId: string,
) {
  await admin
    .from("calendar_sources")
    .delete()
    .eq("user_id", userId)
    .eq("provider", "google")
    .eq("external_id", calendarId);
  await admin
    .from("google_sync_state")
    .delete()
    .eq("user_id", userId)
    .eq("google_calendar_id", calendarId);
}

type Row = {
  id: string;
  starts_at: string;
  ends_at: string;
  description: string | null;
  status: string;
  updated_at: string;
  push_attempts: number;
  source: { name: string } | null;
  scheduled_block_tasks: {
    planned_minutes: number;
    position: number;
    tasks: { description: string | null; category_id: string | null } | null;
  }[];
};

function isRateLimit(error: unknown) {
  return (
    error instanceof GoogleApiError &&
    (error.status === 429 ||
      (error.status === 403 && /rateLimit|userRateLimit|quotaExceeded/i.test(error.body)))
  );
}

/**
 * Bring the Agenda calendar in line with the plan, for one user.
 *
 * Idempotent and safe to run concurrently: the lease makes a second caller skip,
 * and a block is marked synced only if it has not changed since it was read —
 * an edit made mid-push leaves it pending for the next run instead of being
 * recorded as done with the old times.
 */
export async function pushUser(admin: SupabaseClient, userId: string): Promise<PushOutcome> {
  const { data: claimed, error: claimError } = await admin.rpc("claim_push", {
    p_user: userId,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (claimError) return { status: "failed", error: claimError.message };
  if (!claimed) return { status: "skipped", reason: "push disabled or already running" };

  let upserted = 0;
  let deleted = 0;
  let failed = 0;
  let recreated = false;

  try {
    const account = await loadAccount(admin, userId);
    const accessToken = await writeAccessToken(admin, account);

    let calendarId = account.push_calendar_id;
    if (!calendarId) {
      calendarId = await createCalendar(admin, userId, accessToken);
      await forgetPushCalendarAsSource(admin, userId, calendarId);
    }

    const recreate = async () => {
      if (recreated) throw new Error("The Agenda calendar disappeared twice in one run");
      recreated = true;
      await resetPushState(admin, userId);
      calendarId = await createCalendar(admin, userId, accessToken);
      await forgetPushCalendarAsSource(admin, userId, calendarId);
    };

    let operations = 0;
    let rateLimited = false;

    // ----------------------------------------------------------- deletions

    const { data: tombstones } = await admin
      .from("google_push_tombstones")
      .select("google_event_id")
      .eq("user_id", userId)
      .limit(MAX_OPERATIONS);

    for (const t of tombstones ?? []) {
      try {
        await deletePushEvent(accessToken, calendarId, t.google_event_id);
      } catch (error) {
        if (isRateLimit(error)) {
          rateLimited = true;
          break;
        }
        throw error;
      }
      await admin
        .from("google_push_tombstones")
        .delete()
        .eq("user_id", userId)
        .eq("google_event_id", t.google_event_id);
      deleted++;
      operations++;
    }

    // --------------------------------------------------- creates / updates

    const { data: categories } = await admin
      .from("categories")
      .select("id, name")
      .eq("user_id", userId);
    const categoryName = new Map((categories ?? []).map((c) => [c.id as string, c.name as string]));

    const appUrl = Deno.env.get("APP_URL") ?? null;
    const givenUp = new Set<string>();

    while (!rateLimited && operations < MAX_OPERATIONS) {
      const { data, error } = await admin
        .from("scheduled_blocks")
        .select(
          "id, starts_at, ends_at, description, status, updated_at, push_attempts, source:blocks(name), scheduled_block_tasks(planned_minutes, position, tasks(description, category_id))",
        )
        .eq("user_id", userId)
        .or(`sync_state.eq.pending,and(sync_state.eq.failed,push_attempts.lt.${MAX_ATTEMPTS})`)
        // What is coming up matters more than a backfill of past weeks.
        .order("starts_at", { ascending: false })
        .limit(BATCH);
      if (error) throw error;

      const rows = ((data ?? []) as unknown as Row[]).filter((r) => !givenUp.has(r.id));
      if (rows.length === 0) break;

      for (const row of rows) {
        if (operations >= MAX_OPERATIONS) break;
        operations++;

        const block: PushBlock = {
          id: row.id,
          starts_at: row.starts_at,
          ends_at: row.ends_at,
          description: row.description,
          status: row.status,
          templateName: row.source?.name ?? null,
          tasks: row.scheduled_block_tasks.map((l) => ({
            categoryName: l.tasks?.category_id
              ? (categoryName.get(l.tasks.category_id) ?? null)
              : null,
            description: l.tasks?.description ?? null,
            minutes: l.planned_minutes,
            position: l.position,
          })),
        };

        try {
          const event = eventFor(block, appUrl);
          try {
            await putPushEvent(accessToken, calendarId, event);
          } catch (error) {
            if (!(error instanceof PushCalendarGoneError)) throw error;
            // Everything was reset to pending; the next batch starts over
            // against the new calendar.
            await recreate();
            break;
          }

          await admin
            .from("scheduled_blocks")
            .update({
              google_event_id: event.id,
              google_synced_at: new Date().toISOString(),
              sync_state: "synced",
              push_attempts: 0,
              push_error: null,
            })
            .eq("id", row.id)
            .eq("updated_at", row.updated_at);
          upserted++;
        } catch (error) {
          if (isRateLimit(error)) {
            // Not this block's fault. Leave it pending; the cron resumes.
            rateLimited = true;
            break;
          }
          if (error instanceof GrantRevokedError) throw error;

          failed++;
          givenUp.add(row.id);
          await admin
            .from("scheduled_blocks")
            .update({
              sync_state: "failed",
              push_attempts: row.push_attempts + 1,
              push_error: error instanceof Error ? error.message : String(error),
            })
            .eq("id", row.id)
            .eq("updated_at", row.updated_at);
        }
      }
    }

    await admin
      .from("google_accounts")
      .update({
        last_pushed_at: new Date().toISOString(),
        push_error: rateLimited ? "Google rate limit reached — the rest follows within a minute." : null,
        push_error_at: rateLimited ? new Date().toISOString() : null,
      })
      .eq("user_id", userId);

    return { status: "pushed", upserted, deleted, failed, recreated };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();

    if (error instanceof GrantRevokedError) {
      await admin
        .from("google_accounts")
        .update({
          disconnected_at: now,
          last_error: "Google access was revoked. Reconnect to resume syncing.",
          last_error_at: now,
        })
        .eq("user_id", userId);
    }

    await admin
      .from("google_accounts")
      .update({ push_error: message, push_error_at: now })
      .eq("user_id", userId);

    return { status: "failed", error: message };
  } finally {
    await admin.rpc("release_push", { p_user: userId });
  }
}

/** Turn push on: the calendar is created and filled by the first run. */
export async function enablePush(admin: SupabaseClient, userId: string) {
  const account = await loadAccount(admin, userId);
  if (account.disconnected_at) throw new Error("Connect Google Calendar first");
  // Fails early, with the message that says what to do, rather than on the
  // first block.
  await writeAccessToken(admin, account);

  const { error } = await admin
    .from("google_accounts")
    .update({ push_enabled: true, push_error: null, push_error_at: null })
    .eq("user_id", userId);
  if (error) throw error;

  return await pushUser(admin, userId);
}

/**
 * Turn push off and take the Agenda calendar down with it.
 *
 * Leaving it behind would leave a frozen copy of the plan in Google that
 * silently drifts from the real one — worse than no copy.
 */
export async function disablePush(admin: SupabaseClient, userId: string) {
  const account = await loadAccount(admin, userId);

  const { error } = await admin
    .from("google_accounts")
    .update({ push_enabled: false, push_calendar_id: null, push_error: null, push_error_at: null })
    .eq("user_id", userId);
  if (error) throw error;

  let calendarError: string | null = null;
  if (account.push_calendar_id) {
    try {
      await deletePushCalendar(await writeAccessToken(admin, account), account.push_calendar_id);
    } catch (e) {
      calendarError = e instanceof Error ? e.message : String(e);
    }
  }

  await resetPushState(admin, userId);
  return { calendarError };
}
