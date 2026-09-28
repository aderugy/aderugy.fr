import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { SpotView } from "@/components/poker/SpotView";
import { asSetup, type PokerSpot } from "@/lib/solver/types";

export default async function SpotPage({
  params,
  searchParams,
}: PageProps<"/poker/spots/[spotId]">) {
  const { spotId } = await params;
  const { node: focusNode } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(LOGIN_PATH);

  const { data, error } = await supabase
    .from("poker_spots")
    .select("id, name, description, setup, created_at, updated_at")
    .eq("id", spotId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
        <h1 className="font-medium">Could not load this spot</h1>
        <p className="mt-2 text-muted">{error.message}</p>
      </main>
    );
  }
  if (!data) notFound();

  const spot = data as PokerSpot;
  // The tree loads in the browser (all of it, the study layout walks it);
  // ?node=<id> (from a trainer) opens on that node.
  return (
    <SpotView
      spotId={spot.id}
      spotName={spot.name}
      initialSetup={asSetup(spot.setup)}
      initialFocus={typeof focusNode === "string" ? focusNode : null}
    />
  );
}
