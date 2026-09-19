import Link from "next/link";
import { PokerCalculator } from "@/components/poker/PokerCalculator";
import { getRakeProfiles } from "@/server/rake";

export const metadata = {
  title: "Poker odds — aderugy.fr",
  description: "Pot odds, drawing equity and semi-bluff fold equity, rake included.",
};

// The rake presets change a few times a year, and nothing on this page is
// per-visitor, so it is rendered once and revalidated daily rather than on
// every request.
export const revalidate = 86400;

export default async function PokerPage() {
  const profiles = await getRakeProfiles();

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="flex items-center justify-between">
        <Link href="/" className="text-xs text-muted hover:text-foreground">
          ← aderugy.fr
        </Link>
        <span className="flex gap-4">
          <Link href="/poker/spots" className="text-xs text-muted hover:text-foreground">
            Solver notes →
          </Link>
          <Link href="/poker/trainers" className="text-xs text-muted hover:text-foreground">
            Trainers →
          </Link>
        </span>
      </div>
      <h1 className="mt-3 text-lg font-semibold tracking-tight">Poker odds</h1>
      <p className="mt-1 text-sm text-muted">
        What a call needs, what a draw is worth, and how often a semi-bluff has to get
        through. Everything in big blinds, with the site&apos;s rake taken off the pot.
      </p>

      <div className="mt-6">
        <PokerCalculator profiles={profiles} />
      </div>
    </main>
  );
}
