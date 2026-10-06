import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { SignOutButton } from "@/components/agenda/SignOutButton";

const nav = [
  { href: "/jobs", label: "Applications" },
  { href: "/jobs/companies", label: "Companies" },
  { href: "/jobs/tags", label: "Tags" },
  { href: "/agenda", label: "Agenda ↗" },
];

export const metadata = { title: "Jobs — aderugy.fr" };

export default async function JobsLayout({ children }: LayoutProps<"/jobs">) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // The proxy already gates this segment; this keeps a misconfigured proxy
  // from rendering an empty page.
  if (!user) redirect(LOGIN_PATH);

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b border-line bg-background px-3 sm:gap-6 sm:px-5">
        <Link href="/" className="hidden shrink-0 text-xs text-muted hover:text-foreground sm:inline">
          ←
        </Link>
        <Link href="/jobs" className="shrink-0 text-sm font-semibold tracking-tight">
          Jobs
        </Link>
        <nav className="-mx-1 flex min-w-0 gap-3 overflow-x-auto px-1 text-sm text-muted sm:gap-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="shrink-0 hover:text-foreground">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-3 text-xs text-muted">
          <SignOutButton />
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
