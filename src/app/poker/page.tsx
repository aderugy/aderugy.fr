import { PokerCalculator } from "@/components/poker/PokerCalculator";
import { PokerHeader } from "@/components/poker/PokerHeader";
import { getRakeProfiles } from "@/server/rake";

export const metadata = {
  title: "Calculator — Poker",
  description: "Pot odds, drawing equity and semi-bluff fold equity, rake included.",
};

// The rake presets change a few times a year, and nothing on this page is
// per-visitor, so it is rendered once and revalidated daily rather than on
// every request. That is also why the header here carries no account block:
// reading the session would make the page dynamic.
export const revalidate = 86400;

export default async function PokerPage() {
  const profiles = await getRakeProfiles();

  return (
    // Same shell as Solver notes and Trainers: fixed header, body scrolls.
    <div className="flex h-[100dvh] flex-col">
      <PokerHeader />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
          <h1 className="text-lg font-semibold tracking-tight">Calculator</h1>
          <p className="mt-1 text-sm text-muted">
            What a call needs, what a draw is worth, and how often a semi-bluff has to
            get through. Everything in big blinds, with the site&apos;s rake taken off
            the pot.
          </p>
          <div className="mt-6">
            <PokerCalculator profiles={profiles} />
          </div>
        </main>
      </div>
    </div>
  );
}
