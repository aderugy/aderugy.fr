import { createServerClient } from "@supabase/ssr";
import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { LOGIN_PATH, safeNext } from "@/lib/supabase/session";

/**
 * OAuth / e-mail landing. Three shapes arrive here:
 *
 * - `?code=…`        PKCE, used by the Google sign-in flow. The verifier lives
 *                    in a cookie, which is fine: the round trip starts and ends
 *                    in the same browser.
 * - `?token_hash=…`  Server-side verification, for e-mail links. Kept so a
 *                    magic-link or invite flow can be re-enabled without
 *                    touching this route.
 * - `?error=…`       The provider or Supabase refused. Surface it rather than
 *                    bouncing to a blank form.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNext(searchParams.get("next"));

  // Providers report failures on the redirect itself — no code will follow.
  const upstreamError =
    searchParams.get("error_description") ?? searchParams.get("error");
  if (upstreamError) return fail(origin, upstreamError, next);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return fail(origin, "Supabase is not configured", next);

  // Built first so the Supabase client can write session cookies straight onto
  // the response we are about to return.
  const response = NextResponse.redirect(`${origin}${next}`);

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return fail(origin, error.message, next);
    return response;
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (error) return fail(origin, error.message, next);
    return response;
  }

  return fail(origin, "This sign-in link is missing its token.", next);
}

function fail(origin: string, message: string, next?: string) {
  const target = new URL(`${origin}${LOGIN_PATH}`);
  target.searchParams.set("error", message);
  if (next) target.searchParams.set("next", next);
  return NextResponse.redirect(target);
}
