import { createClient, userFromClaims } from "@/lib/supabase/server";
import { loadMedia } from "@/server/flashcards/data";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An image pasted into a note. Served with the viewer's own session, so RLS
 * decides: another user's image is a 404. Images never change once stored,
 * so the browser may keep them (privately) for a long time.
 */
export async function GET(_req: Request, ctx: RouteContext<"/flashcards/media/[id]">) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return new Response("Not found", { status: 404 });
  const supabase = await createClient();
  const user = await userFromClaims(supabase);
  if (!user) return new Response("Unauthorized", { status: 401 });
  const media = await loadMedia(supabase, user.id, id);
  if (!media) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(media.bytes), {
    headers: {
      "Content-Type": media.mime,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
