import Link from "next/link";
import { SignOutButton } from "@/components/agenda/SignOutButton";
import { PokerNav } from "./PokerNav";

/**
 * The header every /poker page shares: back to the site, the poker nav, and the
 * account on the right. `email` is optional because the calculator is public and
 * statically rendered — reading the session there would make it per-request —
 * so it shows the same bar without the account block.
 */
export function PokerHeader({ email }: { email?: string | null }) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-2 sm:gap-6 sm:px-5 sm:py-3">
      <Link
        href="/"
        className="hidden shrink-0 text-xs text-muted hover:text-foreground sm:inline"
      >
        ←
      </Link>
      <PokerNav />
      {email !== undefined && (
        <div className="ml-auto flex shrink-0 items-center gap-3 text-xs text-muted">
          {email && <span className="hidden lg:inline">{email}</span>}
          <SignOutButton />
        </div>
      )}
    </header>
  );
}
