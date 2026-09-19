import Link from "next/link";
import { notFound } from "next/navigation";
import { comboCards } from "@/lib/solver/cards";
import { GRADE_LABELS, type Grade } from "@/lib/trainer/types";
import { getSessionReview } from "@/server/trainers";
import { BandBar, GRADE_STYLES, GradeCounts } from "@/components/poker/trainer/Practice";
import { BoardCards, PlayingCard } from "@/components/poker/trainer/Cards";

const SEVERITY: Record<Grade, number> = { blunder: 0, mistake: 1, wrong_band: 2, correct: 3 };

export default async function SessionReviewPage({
  params,
}: PageProps<"/poker/trainers/[trainerId]/sessions/[sessionId]">) {
  const { trainerId, sessionId } = await params;
  const review = await getSessionReview(trainerId, sessionId);
  if (!review) notFound();
  const { trainer, session, answers } = review;

  const counts: Record<Grade, number> = { correct: 0, wrong_band: 0, mistake: 0, blunder: 0 };
  for (const a of answers) counts[a.grade]++;
  const sorted = answers
    .map((a, i) => ({ a, i }))
    .sort((x, y) => SEVERITY[x.a.grade] - SEVERITY[y.a.grade] || x.i - y.i);
  const score = session.hands ? Math.round((session.correct / session.hands) * 100) : null;

  return (
    <main className="mx-auto h-full w-full max-w-3xl overflow-y-auto px-3 py-4 sm:px-6 sm:py-6">
      <Link href={`/poker/trainers/${trainer.id}`} className="text-xs text-muted hover:text-foreground">
        ← {trainer.name}
      </Link>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Session review</h1>
          <p className="text-xs text-muted">
            {new Date(session.started_at).toLocaleString()} · {session.hands} hands
          </p>
        </div>
        <span className="text-3xl font-semibold tabular-nums">{score === null ? "—" : `${score}%`}</span>
      </div>
      <GradeCounts counts={counts} />

      <ul className="mt-4 space-y-2">
        {sorted.map(({ a, i }) => {
          const actions = a.actions;
          const chosen = actions.find((x) => x.id === a.chosen_action_id);
          const expected = actions.find((x) => x.id === a.expected_action_id);
          const [c1, c2] = comboCards(a.combo);
          return (
            <li key={a.id} className="rounded-lg border border-line bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] tabular-nums text-muted">#{i + 1}</span>
                <span className="flex gap-0.5">
                  <PlayingCard card={c1} size="sm" />
                  <PlayingCard card={c2} size="sm" />
                </span>
                {a.board.length > 0 && <BoardCards cards={a.board} size="sm" />}
                <span className={`ml-auto rounded px-1.5 py-0.5 text-[11px] font-semibold ${GRADE_STYLES[a.grade]}`}>
                  {GRADE_LABELS[a.grade]}
                </span>
              </div>
              <p className="mt-2 text-xs">
                Roll <b className="tabular-nums">{a.rng}</b> → {expected?.label ?? "?"}
                {a.grade !== "correct" && (
                  <>
                    {" "}
                    · you played <b>{chosen?.label ?? "?"}</b>{" "}
                    <span className="text-muted">({Math.round(Number(a.chosen_freq) * 10) / 10}%)</span>
                  </>
                )}
              </p>
              <div className="mt-2">
                <BandBar
                  vector={a.freqs.map(Number)}
                  colors={actions.map((x) => x.color)}
                  labels={actions.map((x) => x.label)}
                  rng={a.rng}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
