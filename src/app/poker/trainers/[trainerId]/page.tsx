import Link from "next/link";
import { notFound } from "next/navigation";
import { TrainerView } from "@/components/poker/trainer/TrainerView";
import { getTrainerPage } from "@/server/trainers";

export default async function TrainerPage({ params }: PageProps<"/poker/trainers/[trainerId]">) {
  const { trainerId } = await params;
  let page;
  try {
    page = await getTrainerPage(trainerId);
  } catch (e) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
        <h1 className="font-medium">Could not load this trainer</h1>
        <p className="mt-2 text-muted">{e instanceof Error ? e.message : String(e)}</p>
      </main>
    );
  }
  if (!page) notFound();

  return (
    <main className="mx-auto h-full w-full max-w-4xl overflow-y-auto px-3 py-4 sm:px-6 sm:py-6">
      <Link href="/poker/trainers" className="text-xs text-muted hover:text-foreground">
        ← Trainers
      </Link>
      <TrainerView {...page} />
    </main>
  );
}
