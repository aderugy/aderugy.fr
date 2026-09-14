"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";

/**
 * Sign out on the server so the auth cookies are cleared by Set-Cookie rather
 * than by JavaScript. A client-side signOut() can only clear cookies it can see
 * from `document.cookie`, which leaves a half-signed-out browser if the cookie
 * flags ever change.
 */
export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect(LOGIN_PATH);
}
