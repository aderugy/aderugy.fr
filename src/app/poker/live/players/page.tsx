import { requireUser } from "@/server/auth";
import { loadPlayers, loadTags } from "@/server/live/data";
import { PlayerList } from "@/components/poker/live/PlayerList";
import { LoadError } from "../load-error";

export const metadata = { title: "Players — Live" };

export default async function PlayersPage() {
  const { supabase, user } = await requireUser();
  let loaded;
  try {
    const [players, tags] = await Promise.all([loadPlayers(supabase, user.id), loadTags(supabase, user.id)]);
    loaded = { players, tags };
  } catch (e) {
    return <LoadError what="your players" error={e} />;
  }
  return <PlayerList players={loaded.players} tags={loaded.tags} />;
}
