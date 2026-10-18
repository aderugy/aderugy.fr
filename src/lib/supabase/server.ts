import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // Session refresh is handled by middleware, so this is safe to ignore.
          }
        },
      },
    },
  );
}

/** The signed-in user, as far as server code needs it. */
export type SessionUser = { id: string; email: string | null };

/**
 * Who is signed in, read from the verified access token.
 *
 * `getClaims()` checks the JWT signature locally against the project's JWKS
 * (asymmetric ES256 keys, cached process-wide for ten minutes), where
 * `getUser()` made a round trip to Supabase Auth on every call — one per
 * layout, page and action, all in series with the queries after them.
 *
 * The trade-off: a session revoked server-side stays usable until its access
 * token expires (one hour). For a single-user site that is acceptable; the
 * OAuth consent page still calls `getUser()`, where it matters.
 */
export async function userFromClaims(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<SessionUser | null> {
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return null;
  const claims = data.claims as Record<string, unknown>;
  if (typeof claims.sub !== "string" || claims.role !== "authenticated") return null;
  return { id: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
}
