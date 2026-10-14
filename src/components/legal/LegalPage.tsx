import Link from "next/link";
import type { ReactNode } from "react";

/** Who to write to about the site, an account or personal data. */
export const CONTACT_EMAIL = "arthur.goullet-de-rugy@epita.fr";

/** Shown on both pages; bump it whenever either text changes. */
export const LAST_UPDATED = "14 October 2026";

export function LegalPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-16 sm:px-6 sm:py-24">
      <Link href="/" className="text-sm text-muted hover:text-foreground">
        ← aderugy.fr
      </Link>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-muted">Last updated: {LAST_UPDATED}</p>
      <div className="mt-6 text-[15px] leading-relaxed">{intro}</div>
      <div className="mt-4">{children}</div>
      <LegalFooter className="mt-16" />
    </main>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed [&_a]:text-accent [&_a]:underline-offset-2 hover:[&_a]:underline [&_li]:mt-1.5 [&_strong]:font-medium [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}

export function Mail() {
  return <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>;
}

/** The two links, for the bottom of any page that should carry them. */
export function LegalFooter({ className = "" }: { className?: string }) {
  return (
    <footer className={`flex gap-4 text-xs text-muted ${className}`}>
      <Link href="/terms" className="hover:text-foreground">
        Terms of use
      </Link>
      <Link href="/privacy" className="hover:text-foreground">
        Privacy policy
      </Link>
    </footer>
  );
}
