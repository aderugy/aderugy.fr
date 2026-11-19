import { redirect } from "next/navigation";
import { createClient, userFromClaims } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { PokerHeader } from "@/components/poker/PokerHeader";
import { loadLive } from "@/server/now";

export default async function HudLayout({ children }: LayoutProps<"/poker/hud">) {
  const supabase = await createClient();
  const user = await userFromClaims(supabase);
  // The proxy already gates this; the guard keeps a misconfigured proxy from
  // rendering a blank, signed-out page.
  if (!user) redirect(LOGIN_PATH);
  // The way back to a running session, in the header of every page below.
  const running = await loadLive(supabase, user.id);

  return (
    <div className="flex h-[100dvh] flex-col">
      <PokerHeader email={user.email ?? null} running={running} />
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
