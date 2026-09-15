import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "@/components/agenda/SignOutButton";

const nav = [
  { href: "/agenda", label: "Week" },
  { href: "/agenda/backlog", label: "Backlog" },
  { href: "/agenda/blocks", label: "Blocks" },
  { href: "/agenda/settings", label: "Settings" },
];

export default async function AgendaLayout({ children }: LayoutProps<"/agenda">) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The login page renders inside this layout too, before there is a user.
  if (!user) return <>{children}</>;

  return (
    /**
     * The shell owns the viewport height so the pages inside can ask for all of
     * it without knowing how tall the header happens to be. `dvh` rather than
     * `vh`: on a phone the browser's own chrome slides in and out, and `vh`
     * measures the tallest state, which puts the bottom of the planner under
     * the address bar.
     */
    <div className="flex h-[100dvh] flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-2 sm:gap-6 sm:px-5 sm:py-3">
        <Link
          href="/agenda"
          className="shrink-0 text-sm font-semibold tracking-tight"
        >
          Agenda
        </Link>
        {/* Scrolls rather than wraps: a header that changes height would move
            the grid underneath it every time the nav needed a second line. */}
        <nav className="-mx-1 flex min-w-0 gap-3 overflow-x-auto px-1 text-sm text-muted sm:gap-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="shrink-0 hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-3 text-xs text-muted">
          <span className="hidden lg:inline">{user.email}</span>
          <SignOutButton />
        </div>
      </header>
      {/* `min-h-0` so a tall child scrolls inside the shell instead of pushing
          the page past the bottom of the screen. */}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
