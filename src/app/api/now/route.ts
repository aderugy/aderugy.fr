import { NextResponse, type NextRequest } from "next/server";
import { createClient, userFromClaims } from "@/lib/supabase/server";
import { loadLive, loadNow } from "@/server/now";

/**
 * The signed-in "right now" for pages that are rendered statically — the home
 * page and the poker calculator — so they can show the way back to a running
 * session without reading cookies at render time. `?scope=live` reads only
 * the running session. Signed out: 204, and the page shows nothing extra.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const user = await userFromClaims(supabase);
  if (!user) return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });

  const body =
    request.nextUrl.searchParams.get("scope") === "live"
      ? { live: await loadLive(supabase, user.id) }
      : await loadNow(supabase, user.id);
  return NextResponse.json(body, { headers: { "Cache-Control": "private, no-store" } });
}
