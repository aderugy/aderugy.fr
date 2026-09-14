import { createServerClient } from "@supabase/ssr";
import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { LOGIN_PATH, safeNext } from "@/lib/supabase/session";

/**
 * Magic-link landing. Two shapes arrive here and both must work:
 *
 * - `?code=…`        PKCE. Only verifiable in the browser that requested the
 *                    link, because the code verifier lives in a cookie there.
 * - `?token_hash=…`  Server-side verification. Works from any browser, so the
 *                    link survives being opened on a phone or a second profile.
 *                    Emitted when the email template uses `{{ .TokenHash }}`.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNext(searchParams.get("next"));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return fail(origin, "Supabase is not configured");

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

  // Supabase forwards its own failures here as ?error_description=…
  const upstream = searchParams.get("error_description");
  return fail(origin, upstream ?? "This sign-in link is missing its token.", next);
}

function fail(origin: string, message: string, next?: string) {
  const target = new URL(`${origin}${LOGIN_PATH}`);
  target.searchParams.set("error", message);
  if (next) target.searchParams.set("next", next);
  return NextResponse.redirect(target);
}
