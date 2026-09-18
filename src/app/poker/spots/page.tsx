import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { SpotList } from "@/components/poker/SpotList";
import type { PokerSpot } from "@/lib/solver/types";

export const metadata = { title: "Solver notes — Poker" };

export default async function SpotsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(LOGIN_PATH);

  const { data, error } = await supabase
    .from("poker_spots")
    .select("id, name, description, created_at, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  if (error) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
        <h1 className="font-medium">Could not load your spots</h1>
        <p className="mt-2 text-muted">{error.message}</p>
      </main>
    );
  }

  const spots = (data ?? []) as PokerSpot[];

  return (
    <main className="mx-auto h-full w-full max-w-3xl overflow-y-auto px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="text-lg font-semibold tracking-tight">Spots</h1>
      <p className="mt-1 text-sm text-muted">
        A spot is a solver tree — a preflop matchup like BTN vs BB SRP. Open one
        to build its flop, strategies and lines.
      </p>
      <div className="mt-6">
        <SpotList spots={spots} />
      </div>
    </main>
  );
}
