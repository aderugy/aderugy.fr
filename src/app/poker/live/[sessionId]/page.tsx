import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getSessionBundle } from "@/server/live/data";
import { SessionScreen } from "@/components/poker/live/SessionScreen";
import { SessionReview } from "@/components/poker/live/SessionReview";
import { LoadError, UUID } from "../load-error";

export async function generateMetadata({ params }: PageProps<"/poker/live/[sessionId]">) {
  const { sessionId } = await params;
  if (!UUID.test(sessionId)) return { title: "Session — Poker" };
  const { supabase, user } = await requireUser();
  const { data } = await supabase.from("live_sessions").select("venue").eq("user_id", user.id).eq("id", sessionId).maybeSingle();
  return { title: data?.venue ? `${data.venue} — Live` : "Session — Poker" };
}

/** The table while the session runs; its review once it has ended. */
export default async function SessionPage({ params }: PageProps<"/poker/live/[sessionId]">) {
  const { sessionId } = await params;
  if (!UUID.test(sessionId)) notFound();
  const { supabase, user } = await requireUser();
  let data;
  try {
    data = await getSessionBundle(supabase, user.id, sessionId);
  } catch (e) {
    return <LoadError what="this session" error={e} />;
  }
  if (!data) notFound();
  return data.session.ended_at ? <SessionReview data={data} /> : <SessionScreen data={data} />;
}
