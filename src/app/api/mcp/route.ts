import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { RESOURCE_METADATA_PATH, verifyToken } from "@/server/mcp/auth";
import { SERVER_INSTRUCTIONS, registerBacklogTools } from "@/server/mcp/backlog-tools";

/**
 * The Claude connector for the /agenda backlog — a remote MCP server over
 * Streamable HTTP, stateless (mcp-handler v2: no Redis, no sessions).
 *
 * Unauthenticated requests get a 401 whose WWW-Authenticate header points at
 * the protected-resource metadata, which names Supabase Auth as the
 * authorization server. See docs: agenda/claude-connector-plan.md.
 */

export const maxDuration = 30;

const handler = createMcpHandler(registerBacklogTools, {
  serverInfo: { name: "aderugy-agenda", version: "1.0.0" },
  instructions: SERVER_INSTRUCTIONS,
});

const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceMetadataPath: RESOURCE_METADATA_PATH,
  resourceUrl: process.env.MCP_RESOURCE_URL
    ? new URL(process.env.MCP_RESOURCE_URL).origin
    : undefined,
});

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
