import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export const LOGIN_PATH = "/agenda/login";
export const HOME_PATH = "/agenda";

/** Only same-origin agenda paths may be used as a post-login destination. */
export function safeNext(value: string | null | undefined): string {
  if (!value) return HOME_PATH;
  if (!value.startsWith("/agenda")) return HOME_PATH;
  if (value.startsWith("//")) return HOME_PATH;
  if (value.startsWith(LOGIN_PATH)) return HOME_PATH;
  return value;
}

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Without credentials there is no session to refresh; let the page render and
  // surface a configuration message rather than crashing the whole proxy.
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // Do not run code between createServerClient and getUser: a stray await here
  // is the classic cause of randomly signed-out users.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const onLoginPage = path === LOGIN_PATH;

  if (!user && !onLoginPage) {
    return redirectKeepingCookies(request, response, LOGIN_PATH, { next: path });
  }

  // Already signed in: never show the form again on this browser.
  if (user && onLoginPage) {
    return redirectKeepingCookies(
      request,
      response,
      safeNext(request.nextUrl.searchParams.get("next")),
    );
  }

  return response;
}

/**
 * Redirect while carrying over any cookies Supabase just wrote.
 *
 * getUser() can rotate the refresh token. Returning a bare NextResponse.redirect
 * throws those Set-Cookie headers away, so the old token is spent and the new
 * one never reaches the browser — the session dies and the next request bounces
 * back to the login page. That is the "why am I signing in twice" bug.
 */
function redirectKeepingCookies(
  request: NextRequest,
  carrying: NextResponse,
  pathname: string,
  params?: Record<string, string>,
) {
  const target = request.nextUrl.clone();
  target.pathname = pathname;
  target.search = "";
  for (const [k, v] of Object.entries(params ?? {})) {
    target.searchParams.set(k, v);
  }

  const redirect = NextResponse.redirect(target);
  for (const cookie of carrying.cookies.getAll()) redirect.cookies.set(cookie);
  return redirect;
}
