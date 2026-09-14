import "server-only";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  return { supabase, user };
}

export function fail(error: unknown): ActionResult {
  const message =
    error instanceof Error ? error.message : "Something went wrong";
  return { ok: false, error: message };
}
