import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getSessionBundle } from "@/server/live/data";
import { HandView } from "@/components/poker/live/HandView";
import { LoadError, UUID } from "../../../load-error";

export const metadata = { title: "Hand — Live" };

export default async function HandPage({ params }: PageProps<"/poker/live/[sessionId]/hands/[handId]">) {
  const { sessionId, handId } = await params;
  if (!UUID.test(sessionId) || !UUID.test(handId)) notFound();
  const { supabase, user } = await requireUser();
  let data;
  try {
    data = await getSessionBundle(supabase, user.id, sessionId);
  } catch (e) {
    return <LoadError what="this hand" error={e} />;
  }
  const hand = data?.hands.find((h) => h.id === handId);
  if (!data || !hand) notFound();
  return <HandView key={hand.updated_at} data={data} hand={hand} />;
}
