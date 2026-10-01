"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { refresh } from "next/cache";
import { requireUser, fail, type ActionResult } from "@/server/auth";

/**
 * The consent decision for a connected app (the Claude connector).
 *
 * Supabase's OAuth 2.1 server sends the user to /agenda/oauth/consent; these
 * actions record the answer and send the browser back to the client with a
 * code (approved) or `access_denied` (denied). The decision is made with the
 * owner's own cookie session — a connected app can never approve itself.
 */

const CONSENT_PATH = "/agenda/oauth/consent";

function consentError(id: string, message: string): never {
  const params = new URLSearchParams({ authorization_id: id, error: message });
  redirect(`${CONSENT_PATH}?${params}`);
}

async function decide(formData: FormData, approve: boolean) {
  const id = String(formData.get("authorization_id") ?? "");
  if (!id) redirect(`${CONSENT_PATH}?error=${encodeURIComponent("Missing authorization id")}`);

  let target: string;
  try {
    const { supabase } = await requireUser();
    const { data, error } = approve
      ? await supabase.auth.oauth.approveAuthorization(id, { skipBrowserRedirect: true })
      : await supabase.auth.oauth.denyAuthorization(id, { skipBrowserRedirect: true });
    if (error || !data?.redirect_url) {
      consentError(id, error?.message ?? "The authorization server gave no redirect");
    }
    target = data.redirect_url;
  } catch (e) {
    // redirect() throws to unwind; let it through untouched.
    unstable_rethrow(e);
    consentError(id, e instanceof Error ? e.message : "Something went wrong");
  }
  redirect(target);
}

export async function approveConnection(formData: FormData) {
  await decide(formData, true);
}

export async function denyConnection(formData: FormData) {
  await decide(formData, false);
}

/** Revoke a connected app: its sessions end and its refresh tokens stop working. */
export async function revokeConnectedApp(clientId: string): Promise<ActionResult> {
  try {
    const { supabase } = await requireUser();
    const { error } = await supabase.auth.oauth.revokeGrant({ clientId });
    if (error) throw error;
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
