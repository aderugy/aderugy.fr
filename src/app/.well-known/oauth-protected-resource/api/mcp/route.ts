import { metadataPreflight, protectedResourceMetadata } from "@/server/mcp/metadata";

// RFC 9728 path-suffixed location for the /api/mcp resource — the one the
// 401's WWW-Authenticate header points at.
export function GET(req: Request) {
  return protectedResourceMetadata(req);
}

export const OPTIONS = metadataPreflight;
