import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { SpotCanvas } from "@/components/poker/SpotCanvas";
import type { PokerNode, PokerSpot } from "@/lib/solver/types";

export default async function SpotPage({
  params,
}: PageProps<"/poker/spots/[spotId]">) {
  const { spotId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(LOGIN_PATH);

  const [spotRes, rootsRes] = await Promise.all([
    supabase
      .from("poker_spots")
      .select("id, name, description, created_at, updated_at")
      .eq("id", spotId)
      .eq("user_id", user.id)
      .maybeSingle(),
    // Only the roots load up front; the canvas lazy-loads deeper levels.
    supabase
      .from("poker_nodes")
      .select("id, spot_id, parent_id, type, position, data, created_at, updated_at")
      .eq("user_id", user.id)
      .eq("spot_id", spotId)
      .is("parent_id", null)
      .order("position"),
  ]);

  if (spotRes.error) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
        <h1 className="font-medium">Could not load this spot</h1>
        <p className="mt-2 text-muted">{spotRes.error.message}</p>
      </main>
    );
  }
  if (!spotRes.data) notFound();

  const spot = spotRes.data as PokerSpot;
  const roots = (rootsRes.data ?? []) as PokerNode[];

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
        <Link href="/poker/spots" className="text-xs text-muted hover:text-foreground">
          ← Spots
        </Link>
        <h1 className="truncate text-sm font-medium">{spot.name}</h1>
      </div>
      <div className="min-h-0 flex-1">
        <SpotCanvas spotId={spot.id} initialNodes={roots} />
      </div>
    </div>
  );
}
