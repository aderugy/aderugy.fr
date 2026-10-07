import { requireUser } from "@/server/auth";
import { listSessions, recentVenues } from "@/server/live/data";
import { SessionList } from "@/components/poker/live/SessionList";
import { LoadError } from "./load-error";

export const metadata = { title: "Live sessions — Poker" };

export default async function LivePage() {
  const { supabase, user } = await requireUser();
  let loaded;
  try {
    const [sessions, venues] = await Promise.all([listSessions(supabase, user.id), recentVenues(supabase, user.id)]);
    loaded = { sessions, venues };
  } catch (e) {
    return <LoadError what="your sessions" error={e} />;
  }
  return <SessionList sessions={loaded.sessions} venues={loaded.venues} />;
}
