import Link from "next/link";
import { SignOutButton } from "@/components/agenda/SignOutButton";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import type { RunningSession } from "@/server/live/data";
import { PokerNav } from "./PokerNav";
import { RunningSessionLink } from "./RunningSessionLink";

/**
 * The header every /poker page shares: back to the site, the poker nav, the
 * way back to a running live session, and the account on the right.
 *
 * `email` is optional because the calculator is public and statically
 * rendered — reading the session there would make it per-request — so it shows
 * the same bar without the account block. For the same reason `running` is
 * left undefined there, and the pill asks /api/now from the browser instead.
 */
export function PokerHeader({ email, running }: { email?: string | null; running?: RunningSession | null }) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-line px-3 sm:gap-6 sm:px-5">
      <Link
        href="/"
        aria-label="Home"
        className="hidden shrink-0 text-xs text-muted hover:text-foreground sm:inline standalone:inline"
      >
        ←
      </Link>
      <PokerNav />
      <div className="ml-auto flex shrink-0 items-center gap-3 text-xs text-muted">
        <RunningSessionLink initial={running} />
        <ThemeToggle />
        {email !== undefined && (
          <>
            {email && <span className="hidden lg:inline">{email}</span>}
            <SignOutButton />
          </>
        )}
      </div>
    </header>
  );
}
