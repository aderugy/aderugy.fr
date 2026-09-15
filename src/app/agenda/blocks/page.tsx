import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { BlockLibrary } from "@/components/agenda/BlockLibrary";
import type { Block, Category } from "@/lib/types";

export const metadata = { title: "Blocks — Agenda" };

export default async function BlocksPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Defence in depth: the proxy already gates this, but a bypassed or
  // misconfigured proxy must not render a blank page.
  if (!user) redirect(LOGIN_PATH);

  const [categoriesRes, blocksRes] = await Promise.all([
    supabase
      .from("categories")
      .select("id, parent_id, name, color, position, archived")
      .eq("user_id", user.id)
      .eq("archived", false)
      .order("position"),
    supabase
      .from("blocks")
      .select(
        "id, name, color, default_minutes, default_category_id, preferred_daypart, archived, block_items(id, block_id, position, label, estimated_minutes, category_id)",
      )
      .eq("user_id", user.id)
      .eq("archived", false)
      .order("name"),
  ]);

  const error = categoriesRes.error ?? blocksRes.error;
  if (error) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
        <h1 className="font-medium">Could not load blocks</h1>
        <p className="mt-2 text-muted">{error.message}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <BlockLibrary
        categories={(categoriesRes.data ?? []) as Category[]}
        blocks={(blocksRes.data ?? []) as unknown as Block[]}
      />
    </main>
  );
}
