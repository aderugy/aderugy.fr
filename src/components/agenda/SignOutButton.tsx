"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        await createClient().auth.signOut();
        startTransition(() => {
          router.replace("/agenda/login");
          router.refresh();
        });
      }}
      className="rounded border border-line px-2 py-1 hover:border-accent"
    >
      Sign out
    </button>
  );
}
