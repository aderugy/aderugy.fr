"use server";

import { refresh } from "next/cache";
import { requireUser, fail, type ActionResult } from "@/server/auth";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

/**
 * Calls a Supabase Edge Function as the signed-in user.
 *
 * All Google credentials live inside Supabase; this app only ever forwards the
 * user's own JWT, so nothing here can widen what it is able to reach.
 */
async function callEdge(
  name: string,
  accessToken: string,
  body: Record<string, unknown>,
) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");

  const res = await fetch(`${base}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // Non-JSON error body; use it as-is.
    }
    throw new Error(message || `Edge function ${name} failed (${res.status})`);
  }
  return text ? JSON.parse(text) : {};
}

async function accessTokenOf() {
  const { supabase } = await requireUser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("No active session");
  return session.access_token;
}

/** The Google consent URL. Identity sign-in is untouched by this grant. */
export async function googleConsentUrl(origin: string): Promise<string> {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/agenda/settings/google/callback`,
    response_type: "code",
    scope: CALENDAR_SCOPE,
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
