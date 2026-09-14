import Link from "next/link";
import { PokerCalculator } from "@/components/poker/PokerCalculator";

export const metadata = {
  title: "Poker odds — aderugy.fr",
  description: "Pot odds, drawing equity and semi-bluff fold equity, rake included.",
};

export default function PokerPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link href="/" className="text-xs text-muted hover:text-foreground">
        ← aderugy.fr
      </Link>
      <h1 className="mt-3 text-lg font-semibold tracking-tight">Poker odds</h1>
      <p className="mt-1 text-sm text-muted">
        What a call needs, what a draw is worth, and how often a semi-bluff has to get
        through. Everything in big blinds, with the site&apos;s rake taken off the pot.
      </p>

      <div className="mt-6">
        <PokerCalculator />
      </div>
    </main>
  );
}
