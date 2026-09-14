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
    <div className="flex min-h-full flex-col">
      <header className="flex items-center gap-6 border-b border-line px-5 py-3">
        <Link href="/agenda" className="text-sm font-semibold tracking-tight">
          Agenda
        </Link>
        <nav className="flex gap-4 text-sm text-muted">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="hover:text-foreground">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted">
          <span className="hidden sm:inline">{user.email}</span>
          <SignOutButton />
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
