import { notFound, unstable_rethrow } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getPlayer, handsWithPlayer, loadNotes, loadTags, sessionsWithPlayer } from "@/server/live/data";
import { PlayerView } from "@/components/poker/live/PlayerView";
import { LoadError, UUID } from "../../load-error";

export async function generateMetadata({ params }: PageProps<"/poker/live/players/[playerId]">) {
  const { playerId } = await params;
  if (!UUID.test(playerId)) return { title: "Player — Live" };
  const { supabase, user } = await requireUser();
  const { data } = await supabase.from("live_players").select("name").eq("user_id", user.id).eq("id", playerId).maybeSingle();
  return { title: data?.name ? `${data.name} — Live` : "Player — Live" };
}

export default async function PlayerPage({ params }: PageProps<"/poker/live/players/[playerId]">) {
  const { playerId } = await params;
  if (!UUID.test(playerId)) notFound();
  const { supabase, user } = await requireUser();
  let detail;
  try {
    const player = await getPlayer(supabase, user.id, playerId);
    if (!player) notFound();
    const [tags, links, notes, sessions, hands] = await Promise.all([
      loadTags(supabase, user.id),
      supabase.from("live_player_tags").select("tag_id").eq("user_id", user.id).eq("player_id", playerId),
      loadNotes(supabase, user.id, { playerId }),
      sessionsWithPlayer(supabase, user.id, playerId),
      handsWithPlayer(supabase, user.id, playerId),
    ]);
    if (links.error) throw links.error;
    detail = {
      player,
      tags,
      tagIds: (links.data ?? []).map((l) => l.tag_id as string),
      notes,
      sessions,
      hands,
    };
  } catch (e) {
    unstable_rethrow(e); // notFound() is a throw too
    return <LoadError what="this player" error={e} />;
  }
  return <PlayerView detail={detail} />;
}
