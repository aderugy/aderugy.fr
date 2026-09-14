"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/agenda`,
      },
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
      <p className="mt-6 rounded-lg border border-line bg-surface p-4 text-sm">
        Check <span className="font-medium">{email}</span> for the sign-in link.
      </p>
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
