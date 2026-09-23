import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export const LOGIN_PATH = "/agenda/login";
export const HOME_PATH = "/agenda";

// Segment roots a `next` may point at. Every feature area shares the one Google
// sign-in, so a redirect target is legitimate for any of them.
const ALLOWED_ROOTS = [HOME_PATH, "/poker/spots", "/poker/trainers", "/maths"];

/**
 * The only function allowed to turn a `next` parameter into a redirect target.
 *
 * Accepts same-origin paths under an allow-listed segment root and nothing
 * else. A root must match as a whole segment: a bare prefix test would also
 * pass `/agendafoo`, and `//evil.com` is protocol-relative, so the browser
 * would leave the origin entirely.
 */
export function safeNext(value: string | null | undefined): string {
  if (!value) return HOME_PATH;
  if (value.startsWith("//")) return HOME_PATH;
  if (value === LOGIN_PATH || value.startsWith(`${LOGIN_PATH}?`)) return HOME_PATH;
  if (value.startsWith(`${LOGIN_PATH}/`)) return HOME_PATH;
  const allowed = ALLOWED_ROOTS.some(
    (root) => value === root || value.startsWith(`${root}/`),
  );
  return allowed ? value : HOME_PATH;
}

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const path = request.nextUrl.pathname;
  const onLoginPage = path === LOGIN_PATH;

  // Safety net. When a redirect_to is not allow-listed, Supabase does not fail —
  // it substitutes the project's Site URL, dropping the OAuth code on the site
  // root where nothing can exchange it. The sign-in then fails silently and the
  // user loops back to the login page. Forward it to the callback instead.
  if (path === "/") {
    if (request.nextUrl.searchParams.has("code")) {
      const target = request.nextUrl.clone();
      target.pathname = "/auth/callback";
      return NextResponse.redirect(target);
    }
    return response; // the landing page is public
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Misconfiguration must not fail open. With no credentials nobody can hold a
  // session, so every protected path behaves as signed out; only the login page
  // renders, where it explains what is missing.
  if (!url || !key) {
    if (onLoginPage) return response;
    return redirectKeepingCookies(request, response, LOGIN_PATH, { next: path });
  }

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
