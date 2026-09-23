import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { PokerHeader } from "@/components/poker/PokerHeader";

export default async function TrainersLayout({
  children,
}: LayoutProps<"/poker/trainers">) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // The proxy already gates this; the guard keeps a misconfigured proxy from
  // rendering a blank, signed-out page.
  if (!user) redirect(LOGIN_PATH);

  return (
    <div className="flex h-[100dvh] flex-col">
      <PokerHeader email={user.email ?? null} />
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
