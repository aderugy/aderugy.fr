import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/session";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // "/" is matched only to rescue an OAuth code that Supabase dropped there;
  // updateSession returns immediately for any other request to it, so the
  // landing page costs nothing.
  matcher: ["/", "/agenda/:path*", "/poker/spots/:path*"],
};
