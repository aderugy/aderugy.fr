import "server-only";
import { requireUser } from "@/server/auth";

/**
 * Calls a Supabase Edge Function as the signed-in user.
 *
 * Every credential (Google tokens, VAPID keys) lives inside Supabase; this app
 * only ever forwards the user's own JWT, so nothing here can widen what it can
 * reach.
 */
export async function callEdge(
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

export async function accessTokenOf() {
  const { supabase } = await requireUser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("No active session");
  return session.access_token;
}
