import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { getPublicOrigin } from "mcp-handler";

/**
 * Authentication for the Claude connector at /api/mcp.
 *
 * Supabase Auth is the authorization server (its OAuth 2.1 server, with
 * dynamic client registration). The tokens it issues are ordinary Supabase
 * user JWTs carrying a `client_id` claim, so the MCP route needs no session
 * store of its own: it verifies the JWT, then talks to PostgREST *with that
 * same token*. Every query runs as the user, under RLS — including the
 * restrictions migration 0015 places on OAuth clients. No service-role key.
 */

export const MCP_PATH = "/api/mcp";
export const RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;

function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  return { url: url.replace(/\/$/, ""), key };
}

/**
 * Issuer of the OAuth 2.1 server. Claude reads only the first
 * `authorization_servers` entry, and derives the metadata URL from it
 * (`/.well-known/oauth-authorization-server/auth/v1`), so it must match the
 * `issuer` Supabase advertises. Overridable for a custom auth domain.
 */
export function oauthIssuer(): string {
  return (
    process.env.SUPABASE_OAUTH_ISSUER?.replace(/\/$/, "") ??
    `${supabaseEnv().url}/auth/v1`
  );
}

/** The resource identifier: the MCP URL exactly as entered in Claude. */
export function mcpResourceUrl(req: Request): string {
  const explicit = process.env.MCP_RESOURCE_URL;
  return explicit ?? `${getPublicOrigin(req)}${MCP_PATH}`;
}

// One verifier client per instance: getClaims caches the JWKS on it, so a warm
// function verifies locally instead of calling Supabase on every request.
let verifier: SupabaseClient | null = null;
function verifierClient(): SupabaseClient {
  if (!verifier) {
    const { url, key } = supabaseEnv();
    verifier = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return verifier;
}

/**
 * `verifyToken` for withMcpAuth. Returns undefined for anything that is not a
 * valid, unexpired user token — mcp-handler then answers 401 with the
 * resource-metadata pointer, which is what makes Claude sign in or refresh.
 */
export async function verifyToken(
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;

  // Verifies the signature against the project's JWKS (asymmetric signing
  // keys), or asks Supabase Auth for symmetric ones. Rejects expired tokens.
  const { data, error } = await verifierClient().auth.getClaims(bearerToken);
  if (error || !data?.claims) return undefined;

  const claims = data.claims as Record<string, unknown>;
  const sub = typeof claims.sub === "string" ? claims.sub : null;
  if (!sub || claims.role !== "authenticated") return undefined;

  const clientId =
    typeof claims.client_id === "string" && claims.client_id ? claims.client_id : null;
  const scope = typeof claims.scope === "string" ? claims.scope : "";

  return {
    token: bearerToken,
    clientId: clientId ?? "first-party-session",
    scopes: scope.split(" ").filter(Boolean),
    expiresAt: typeof claims.exp === "number" ? claims.exp : undefined,
    extra: { userId: sub, oauthClientId: clientId },
  };
}

/** A PostgREST client acting as the token's user — RLS applies in full. */
export function dbFor(token: string): SupabaseClient {
  const { url, key } = supabaseEnv();
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** The caller of a tool, from the auth info withMcpAuth attached. */
export function callerOf(authInfo: AuthInfo | undefined): {
  db: SupabaseClient;
  userId: string;
} {
  const userId = authInfo?.extra?.userId;
  if (!authInfo?.token || typeof userId !== "string") {
    // withMcpAuth({ required: true }) makes this unreachable; fail closed anyway.
    throw new Error("Not authenticated");
  }
  return { db: dbFor(authInfo.token), userId };
}
