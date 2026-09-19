import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { SignOutButton } from "@/components/agenda/SignOutButton";
import { PokerNav } from "@/components/poker/PokerNav";

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
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-2 sm:gap-6 sm:px-5 sm:py-3">
        <PokerNav />
        <div className="ml-auto flex shrink-0 items-center gap-3 text-xs text-muted">
          <span className="hidden lg:inline">{user.email}</span>
          <SignOutButton />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
