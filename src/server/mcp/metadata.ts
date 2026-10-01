import "server-only";
import { generateProtectedResourceMetadata } from "mcp-handler";
import { mcpResourceUrl, oauthIssuer } from "./auth";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

/**
 * RFC 9728 protected-resource metadata for /api/mcp.
 *
 * Served at both `/.well-known/oauth-protected-resource/api/mcp` (what the
 * 401 points at, and what Claude probes first) and the bare
 * `/.well-known/oauth-protected-resource` fallback. Both describe the same
 * resource: `resource` must equal the URL entered in Claude, path included.
 */
export function protectedResourceMetadata(req: Request): Response {
  const body = generateProtectedResourceMetadata({
    authServerUrls: [oauthIssuer()],
    resourceUrl: mcpResourceUrl(req),
    additionalMetadata: {
      resource_name: "aderugy.fr agenda backlog",
      bearer_methods_supported: ["header"],
    },
  });
  return new Response(JSON.stringify(body), {
    headers: { ...CORS, "Cache-Control": "max-age=300", "Content-Type": "application/json" },
  });
}

export function metadataPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
