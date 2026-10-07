import { requireUser } from "@/server/auth";
import { loadTags } from "@/server/live/data";
import { LiveTagManager } from "@/components/poker/live/LiveTagManager";
import { LoadError } from "../load-error";

export const metadata = { title: "Player tags — Live" };

export default async function TagsPage() {
  const { supabase, user } = await requireUser();
  let loaded;
  try {
    const [tags, links] = await Promise.all([
      loadTags(supabase, user.id),
      supabase.from("live_player_tags").select("tag_id").eq("user_id", user.id),
    ]);
    if (links.error) throw links.error;
    const counts: Record<string, number> = {};
    for (const l of links.data ?? []) counts[l.tag_id as string] = (counts[l.tag_id as string] ?? 0) + 1;
    loaded = { tags, counts };
  } catch (e) {
    return <LoadError what="your tags" error={e} />;
  }
  return <LiveTagManager tags={loaded.tags} counts={loaded.counts} />;
}
