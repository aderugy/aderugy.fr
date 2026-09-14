"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function LoginForm({ next }: { next: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setPending(true);
    setError(null);

    // Built from the current origin so localhost, previews and production each
    // come back to themselves. Supabase still has to allow-list these URLs, or
    // it silently substitutes the project's Site URL.
    const redirect = new URL("/auth/callback", window.location.origin);
    redirect.searchParams.set("next", next);

    const { error } = await createClient().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: redirect.toString() },
      // Login asks for identity only. Calendar scopes come later as their own
      // consent, so a planning feature can never silently widen sign-in access.
    });

    // On success the browser has already navigated to Google.
    if (error) {
      setError(error.message);
      setPending(false);
    }
  }

  return (
    <div className="mt-6 space-y-3">
      <button
        type="button"
        onClick={signIn}
        disabled={pending}
        className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {pending ? "Redirecting…" : "Continue with Google"}
      </button>
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
