"use server";

import { refresh } from "next/cache";
import { requireUser, fail, type ActionResult } from "@/server/auth";
import { accessTokenOf, callEdge } from "@/server/edge";

/**
 * Read every calendar; write only to calendars this app created itself.
 *
 * `calendar.app.created` is what makes pushing blocks safe to offer: it grants
 * nothing over your existing calendars, so the one the app creates ("Agenda")
 * is the only thing it can ever modify.
 */
const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.app.created",
];

/** The Google consent URL. Identity sign-in is untouched by this grant. */
export async function googleConsentUrl(origin: string): Promise<string> {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/agenda/settings/google/callback`,
    response_type: "code",
    scope: CALENDAR_SCOPES.join(" "),
    // Both are required for a refresh token: offline asks for one, and Google
    // omits it on a repeat consent unless the prompt is forced.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function completeGoogleConnect(
  code: string,
  redirectUri: string,
): Promise<ActionResult> {
  try {
    await callEdge("google-oauth", await accessTokenOf(), {
      action: "connect",
      code,
      redirectUri,
    });
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function disconnectGoogle(): Promise<ActionResult> {
  try {
    await callEdge("google-oauth", await accessTokenOf(), { action: "disconnect" });
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** The on-load freshness layer, and the manual "sync now" button. */
export async function syncGoogleNow(): Promise<ActionResult> {
  try {
    await callEdge("google-sync", await accessTokenOf(), {});
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Start writing your blocks to an "Agenda" calendar in Google.
 *
 * The Edge Function creates the calendar and pushes the first batch before
 * answering, so the settings page can report real numbers straight away.
 */
export async function enableGooglePush(): Promise<ActionResult> {
  try {
    await callEdge("google-push", await accessTokenOf(), { action: "enable" });
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Stop pushing, and delete the Agenda calendar from Google. */
export async function disableGooglePush(): Promise<ActionResult> {
  try {
    await callEdge("google-push", await accessTokenOf(), { action: "disable" });
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Remove an archived event for good.
 *
 * The only destructive thing you may do to the mirror, and the only one that
 * makes sense: an archive is an event the provider has already forgotten, so no
 * sync will restore it — and by the same token no sync will ever remove it
 * either. That decision has to be yours.
 *
 * RLS is what enforces "archived only"; this is the door, not the lock. An
 * event still live upstream matches nothing and comes back as the error below
 * rather than silently doing nothing.
 */
export async function deleteArchivedEvent(input: {
  calendarSourceId: string;
  externalEventId: string;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();

    const { data, error } = await supabase
      .from("external_events")
      .delete()
      .eq("user_id", user.id)
      .eq("calendar_source_id", input.calendarSourceId)
      .eq("external_event_id", input.externalEventId)
      .not("archived_at", "is", null)
      .select("external_event_id");
    if (error) throw error;
    if (!data?.length) {
      throw new Error(
        "Only archived events can be deleted here — this one still exists in your calendar. Remove it there.",
      );
    }

    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * The settings page owns name, colour, category and the inclusion toggles.
 * Everything else about a calendar — which ones exist, their provider ids — is
 * discovered by the sync engine and not editable from the browser.
 */
export async function updateCalendarSource(input: {
  id: string;
  displayName?: string;
  color?: string;
  categoryId?: string | null;
  enabled?: boolean;
  includeAllDay?: boolean;
  includeFree?: boolean;
  includeDeclined?: boolean;
}): Promise<ActionResult> {
  try {
    const { supabase } = await requireUser();

    const { error } = await supabase.rpc("update_calendar_source", {
      p_id: input.id,
      p_display_name: input.displayName ?? null,
      p_color: input.color ?? null,
      p_category_id: input.categoryId ?? null,
      // Distinguishes "leave it alone" from "remove the mapping": both arrive
      // as an absent id otherwise.
      p_clear_category: input.categoryId === null,
      p_enabled: input.enabled ?? null,
      p_include_all_day: input.includeAllDay ?? null,
      p_include_free: input.includeFree ?? null,
      p_include_declined: input.includeDeclined ?? null,
    });
    if (error) throw error;

    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
