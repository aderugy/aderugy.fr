import { metadataPreflight, protectedResourceMetadata } from "@/server/mcp/metadata";

// Fallback location some clients probe when the 401 carries no pointer.
export function GET(req: Request) {
  return protectedResourceMetadata(req);
}

export const OPTIONS = metadataPreflight;
