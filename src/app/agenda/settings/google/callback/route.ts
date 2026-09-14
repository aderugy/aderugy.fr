import { NextResponse, type NextRequest } from "next/server";
import { completeGoogleConnect } from "@/server/actions/google";

/**
 * Where Google returns after the Calendar consent.
 *
 * The code is handed straight to the Edge Function — this route never touches
 * the client secret, and no token is stored on Vercel.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const settings = `${origin}/agenda/settings`;

  const denied = searchParams.get("error");
  if (denied) {
    return NextResponse.redirect(`${settings}?error=${encodeURIComponent(denied)}`);
  }

  const code = searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(
      `${settings}?error=${encodeURIComponent("No authorization code was returned.")}`,
    );
  }

  // Must match the redirect_uri sent to Google exactly, or the exchange fails.
  const result = await completeGoogleConnect(
    code,
    `${origin}/agenda/settings/google/callback`,
  );

  if (!result.ok) {
    return NextResponse.redirect(`${settings}?error=${encodeURIComponent(result.error)}`);
  }
  return NextResponse.redirect(`${settings}?connected=1`);
}
