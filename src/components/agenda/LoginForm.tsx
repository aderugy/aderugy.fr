"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    setError(null);

    // Built from the current origin so localhost, previews and production each
    // come back to themselves. Supabase still has to allow-list these URLs, or
    // it silently substitutes the project's Site URL.
    const redirect = new URL("/auth/callback", window.location.origin);
    redirect.searchParams.set("next", next);

    const { error } = await createClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirect.toString() },
    });

    if (error) {
      setError(error.message);
      setState("idle");
      return;
    }
    setState("sent");
  }

  if (state === "sent") {
    return (
      <div className="mt-6 rounded-lg border border-line bg-surface p-4 text-sm">
        <p>
          Check <span className="font-medium">{email}</span> for the sign-in link.
        </p>
        <button
          onClick={() => setState("idle")}
          className="mt-2 text-xs text-muted underline hover:text-foreground"
        >
          Use a different address
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-3">
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        autoComplete="email"
        className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <button
        type="submit"
        disabled={state === "sending"}
        className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {state === "sending" ? "Sending…" : "Send magic link"}
      </button>
      {error && <p className="text-sm text-red-500">{error}</p>}
    </form>
  );
}
