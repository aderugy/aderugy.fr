import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, userFromClaims } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { SignOutButton } from "@/components/agenda/SignOutButton";
import "katex/dist/katex.min.css";
import "./flashcards.css";

const nav = [
  { href: "/flashcards", label: "Decks" },
  { href: "/flashcards/browse", label: "Browse" },
  { href: "/flashcards/inbox", label: "Inbox" },
  { href: "/flashcards/stats", label: "Stats" },
  { href: "/flashcards/import", label: "Import" },
  { href: "/flashcards/settings", label: "Settings" },
];

export const metadata = { title: "Flashcards — aderugy.fr" };

export default async function FlashcardsLayout({ children }: LayoutProps<"/flashcards">) {
  const supabase = await createClient();
  const user = await userFromClaims(supabase);
  // The proxy already gates this segment; this keeps a misconfigured proxy
  // from rendering an empty page.
  if (!user) redirect(LOGIN_PATH);

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b border-line bg-background px-3 sm:gap-6 sm:px-5">
        <Link href="/" className="hidden shrink-0 text-xs text-muted hover:text-foreground sm:inline standalone:inline">
          ←
        </Link>
        <Link href="/flashcards" className="shrink-0 text-sm font-semibold tracking-tight">
          Flashcards
        </Link>
        <nav className="-mx-1 flex min-w-0 gap-3 overflow-x-auto px-1 text-sm text-muted sm:gap-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="shrink-0 hover:text-foreground">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto hidden shrink-0 items-center gap-3 text-xs text-muted sm:flex">
          <SignOutButton />
        </div>
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
