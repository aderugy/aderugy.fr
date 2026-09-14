import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

/** Service-role client. Never leaves Supabase; bypasses RLS by design. */
export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** Resolves the caller from their Supabase JWT. Returns null when absent or invalid. */
export async function callerFromRequest(request: Request) {
  const authorization = request.headers.get("Authorization");
  if (!authorization) return null;

  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );

  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

/** True when the request carries the service-role key rather than a user JWT. */
export function isServiceRole(request: Request) {
  const header = request.headers.get("Authorization") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return Boolean(key) && header === `Bearer ${key}`;
}

export async function readRefreshToken(
  admin: SupabaseClient,
  secretId: string,
): Promise<string> {
  const { data, error } = await admin.rpc("vault_read", { p_id: secretId });
  if (error) throw error;
  if (!data) throw new Error("Refresh token missing from Vault");
  return data as string;
}

export async function storeRefreshToken(
  admin: SupabaseClient,
  userId: string,
  token: string,
): Promise<string> {
  const { data, error } = await admin.rpc("vault_store", {
    p_secret: token,
    p_name: `google_refresh_token:${userId}`,
  });
  if (error) throw error;
  return data as string;
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
