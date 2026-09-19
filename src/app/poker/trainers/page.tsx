import { TrainerList } from "@/components/poker/trainer/TrainerList";
import { listTrainers } from "@/server/trainers";

export const metadata = { title: "Trainers — Poker" };

export default async function TrainersPage() {
  let trainers;
  try {
    trainers = await listTrainers();
  } catch (e) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
        <h1 className="font-medium">Could not load your trainers</h1>
        <p className="mt-2 text-muted">{e instanceof Error ? e.message : String(e)}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto h-full w-full max-w-3xl overflow-y-auto px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="text-lg font-semibold tracking-tight">Trainers</h1>
      <p className="mt-1 text-sm text-muted">
        A trainer drills strategy nodes from your Solver notes at one matchup. Add nodes from a
        strategy node&apos;s inspector (“Add to trainer…”); each hand is scored against the solver in
        RNG mode.
      </p>
      <div className="mt-6">
        <TrainerList trainers={trainers} />
      </div>
    </main>
  );
}
