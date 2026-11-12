import { requireUser } from "@/server/auth";
import { listAllHands } from "@/server/live/data";
import { HandsList } from "@/components/poker/live/HandsList";
import { LoadError } from "../load-error";

export const metadata = { title: "Hands — Live" };

export default async function HandsPage() {
  const { supabase, user } = await requireUser();
  let hands;
  try {
    hands = await listAllHands(supabase, user.id);
  } catch (e) {
    return <LoadError what="your hands" error={e} />;
  }
  return <HandsList hands={hands} />;
}
