import Link from "next/link";
import { notFound } from "next/navigation";
import { comboCards } from "@/lib/solver/cards";
import { fmtBb } from "@/lib/solver/gameState";
import { streetLines } from "@/lib/trainer/labels";
import { END_LABELS, GRADE_LABELS, STREET_LABELS, type Grade, type TrainerAnswer, type TrainerHand } from "@/lib/trainer/types";
import { getSessionReview } from "@/server/trainers";
import { BandBar, GradeCounts } from "@/components/poker/trainer/Practice";
import { GRADE_STYLES } from "@/components/poker/trainer/grades";
import { BoardCards, PlayingCard } from "@/components/poker/trainer/Cards";

const SEVERITY: Record<Grade, number> = { blunder: 0, mistake: 1, wrong_band: 2, correct: 3 };

type Group = { hand: TrainerHand | null; answers: TrainerAnswer[]; order: number };

/** A hand's worst grade decides where it sits: blunders first, clean hands last. */
function worst(g: Group): number {
  if (g.answers.length === 0) return 4;
  return Math.min(...g.answers.map((a) => SEVERITY[a.grade]));
}

export default async function SessionReviewPage({
  params,
}: PageProps<"/poker/trainers/[trainerId]/sessions/[sessionId]">) {
  const { trainerId, sessionId } = await params;
  const review = await getSessionReview(trainerId, sessionId);
  if (!review) notFound();
  const { trainer, session, answers, hands } = review;

  const counts: Record<Grade, number> = { correct: 0, wrong_band: 0, mistake: 0, blunder: 0 };
  for (const a of answers) counts[a.grade]++;

  // Answers grouped by hand; answers from before hands existed stand alone.
  const groups = new Map<string, Group>();
  hands.forEach((h, i) => groups.set(h.id, { hand: h, answers: [], order: i }));
  let loose = hands.length;
  for (const a of answers) {
    const g = a.hand_id ? groups.get(a.hand_id) : undefined;
    if (g) g.answers.push(a);
    else if (a.hand_id) groups.set(a.hand_id, { hand: null, answers: [a], order: loose++ });
    else groups.set(a.id, { hand: null, answers: [a], order: loose++ });
  }
  for (const g of groups.values()) g.answers.sort((x, y) => (x.step ?? 0) - (y.step ?? 0));
  const sorted = [...groups.values()].sort((x, y) => worst(x) - worst(y) || x.order - y.order);

  const score = session.hands ? Math.round((session.correct / session.hands) * 100) : null;
  const perfect = session.played_hands ? Math.round((session.perfect_hands / session.played_hands) * 100) : null;

  return (
    <main className="mx-auto h-full w-full max-w-3xl overflow-y-auto px-3 py-4 sm:px-6 sm:py-6">
      <Link href={`/poker/trainers/${trainer.id}`} className="text-xs text-muted hover:text-foreground">
        ← {trainer.name}
      </Link>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Session review</h1>
          <p className="text-xs text-muted">
            {new Date(session.started_at).toLocaleString()} · {session.played_hands} hands · {session.hands} decisions
            {perfect !== null ? ` · ${perfect}% perfect hands` : ""}
          </p>
        </div>
        <span className="text-3xl font-semibold tabular-nums">{score === null ? "—" : `${score}%`}</span>
      </div>
      <GradeCounts counts={counts} />

      <ul className="mt-4 space-y-3">
        {sorted.map((g, i) => (
          <HandCard key={g.hand?.id ?? g.answers[0]?.id ?? i} group={g} index={g.order + 1} heroSeat={trainer.hero_seat} />
        ))}
      </ul>
    </main>
  );
}

function HandCard({ group, index, heroSeat }: { group: Group; index: number; heroSeat: string }) {
  const { hand, answers } = group;
  const combo = hand?.combo ?? answers[0]?.combo ?? null;
  const cards = combo ? comboCards(combo) : null;
  const villain = hand?.villain_combo ? comboCards(hand.villain_combo) : null;
  const board = hand?.board ?? answers[answers.length - 1]?.board ?? [];
  const correct = answers.filter((a) => a.grade === "correct").length;
  return (
    <li className="rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] tabular-nums text-muted">#{index}</span>
        {cards && (
          <span className="flex gap-0.5">
            <PlayingCard card={cards[0]} size="sm" />
            <PlayingCard card={cards[1]} size="sm" />
          </span>
        )}
        {board.length > 0 && <BoardCards cards={board} size="sm" />}
        {villain && (
          <span className="flex items-center gap-1 text-[11px] text-muted">
            vs
            <PlayingCard card={villain[0]} size="xs" />
            <PlayingCard card={villain[1]} size="xs" />
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted">
          {answers.length > 0 ? `${correct} / ${answers.length} correct` : "no decision"}
          {hand ? ` · ${END_LABELS[hand.end_reason]}` : ""}
        </span>
      </div>

      {hand && hand.line.length > 0 && (
        <div className="mt-2 space-y-0.5 text-[11px]">
          {streetLines(hand.line, hand.board).map((r) => (
            <div key={r.street} className="flex flex-wrap items-center gap-x-2">
              <span className="w-12 shrink-0 text-muted">{STREET_LABELS[r.street]}</span>
              {r.cards.length > 0 && <BoardCards cards={r.cards} size="xs" />}
              {r.actions
                .map((a) => `${a.seat === heroSeat ? "You" : a.seat} ${a.label.toLowerCase()}${a.amountBb != null && a.kind !== "call" ? ` (${fmtBb(a.amountBb)})` : ""}`)
                .join(" · ")}
            </div>
          ))}
        </div>
      )}

      {answers.map((a) => {
        const chosen = a.actions.find((x) => x.id === a.chosen_action_id);
        const expected = a.actions.find((x) => x.id === a.expected_action_id);
        return (
          <div key={a.id} className="mt-3 border-t border-line pt-2">
            <p className="flex flex-wrap items-center gap-2 text-xs">
              <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${GRADE_STYLES[a.grade]}`}>
                {GRADE_LABELS[a.grade]}
              </span>
              {a.step != null && <span className="text-muted">Decision {a.step + 1}</span>}
              {a.pot_bb != null && <span className="text-muted">· pot {fmtBb(Number(a.pot_bb))}</span>}
              <span>
                Roll <b className="tabular-nums">{a.rng}</b> → {expected?.label ?? "?"}
                {a.grade !== "correct" && (
                  <>
                    {" "}
                    · you played <b>{chosen?.label ?? "?"}</b>{" "}
                    <span className="text-muted">({Math.round(Number(a.chosen_freq) * 10) / 10}%)</span>
                  </>
                )}
              </span>
            </p>
            <div className="mt-2">
              <BandBar
                vector={a.freqs.map(Number)}
                colors={a.actions.map((x) => x.color)}
                labels={a.actions.map((x) => x.label)}
                rng={a.rng}
              />
            </div>
          </div>
        );
      })}
    </li>
  );
}
