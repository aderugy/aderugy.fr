import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_AGENDA_PATHS = ["/agenda/login"];

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Without credentials there is no session to refresh; let the page render and
  // surface a configuration message rather than crashing the whole middleware.
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
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
  const isPublic = PUBLIC_AGENDA_PATHS.some((p) => path.startsWith(p));

  if (!user && !isPublic) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/agenda/login";
    redirect.searchParams.set("next", path);
    return NextResponse.redirect(redirect);
  }

  return response;
}
