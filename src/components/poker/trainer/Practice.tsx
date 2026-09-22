"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { comboCards, comboToHand } from "@/lib/solver/cards";
import { StrategyGrid } from "@/components/poker/StrategyGrid";
import { comboPool, pickWeighted, type ComboEntry } from "@/lib/trainer/deal";
import { buildScene, type Scene } from "@/lib/trainer/scene";
import { bands, normalize, playableFreqs, rollRng, scoreAnswer, sessionScore, type Scored } from "@/lib/trainer/score";
import { GRADE_LABELS, type DrillNode, type Grade, type Trainer } from "@/lib/trainer/types";
import { endSession, startSession } from "@/server/actions/trainers";
import { PokerTable } from "@/components/poker/trainer/PokerTable";
import { BoardCards } from "@/components/poker/trainer/Cards";

type Hand = {
  drill: DrillNode;
  entry: ComboEntry;
  rng: number;
  scene: Scene;
  dealtAt: number;
};

type Answer = { chosenIndex: number; scored: Scored };

type Stats = { hands: number; correct: number; counts: Record<Grade, number>; ms: number };

const EMPTY_STATS: Stats = {
  hands: 0,
  correct: 0,
  counts: { correct: 0, wrong_band: 0, mistake: 0, blunder: 0 },
  ms: 0,
};

export const GRADE_STYLES: Record<Grade, string> = {
  correct: "bg-emerald-600 text-white",
  wrong_band: "bg-amber-500 text-white",
  mistake: "bg-orange-600 text-white",
  blunder: "bg-red-600 text-white",
};

const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(x < 10 ? 2 : 1).replace(/\.?0+$/, ""));

export function Practice({ trainer, nodeCount }: { trainer: Trainer; nodeCount: number }) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [phase, setPhase] = useState<"idle" | "starting" | "playing" | "ending" | "ended">("idle");
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [session, setSession] = useState<{ id: string; drill: DrillNode[] } | null>(null);
  const [hand, setHand] = useState<Hand | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [unsynced, setUnsynced] = useState(0);
  const writes = useRef<Promise<void>>(Promise.resolve());

  // Combo pools are the expensive part of a deal; built once per session.
  const [pools, setPools] = useState<Map<string, ComboEntry[]>>(new Map());

  const deal = useCallback(
    (drill: DrillNode[], pools: Map<string, ComboEntry[]>) => {
      const live = drill.filter((d) => (pools.get(d.nodeId)?.length ?? 0) > 0);
      const d = pickWeighted(live, (x) => x.weight);
      if (!d) {
        setError("None of this trainer's nodes has a live combo to deal.");
        return;
      }
      const entry = pickWeighted(pools.get(d.nodeId)!, (e) => e.weight)!;
      const scene = buildScene({
        heroSeat: trainer.hero_seat,
        villainSeat: trainer.villain_seat,
        potBb: Number(trainer.pot_bb),
        stackBb: Number(trainer.stack_bb),
        street: d.context.street,
        board: d.context.board,
        line: d.context.line,
        heroActions: d.actions,
      });
      setHand({ drill: d, entry, rng: rollRng(), scene, dealtAt: performance.now() });
      setAnswer(null);
    },
    [trainer],
  );

  async function start() {
    setError(null);
    setNotices([]);
    setPhase("starting");
    const r = await startSession(trainer.id);
    if (!r.ok) {
      setError(r.error);
      setPhase("idle");
      return;
    }
    const n: string[] = [];
    if (r.updated > 0) n.push(`${r.updated} node${r.updated > 1 ? "s" : ""} updated from the tree.`);
    for (const s of r.skipped) n.push(`Skipped a node: ${s.reason}`);
    setNotices(n);
    setStats(EMPTY_STATS);
    setHand(null);
    setAnswer(null);
    const built = buildPools(r.drill);
    setPools(built);
    setSession({ id: r.sessionId, drill: r.drill });
    setPhase("playing");
    deal(r.drill, built);
  }

  function choose(index: number) {
    if (!hand || answer || !session) return;
    const scored = scoreAnswer(hand.entry.vector, hand.rng, index);
    if (!scored) return;
    const ms = Math.round(performance.now() - hand.dealtAt);
    setAnswer({ chosenIndex: index, scored });
    setStats((s) => ({
      hands: s.hands + 1,
      correct: s.correct + (scored.grade === "correct" ? 1 : 0),
      counts: { ...s.counts, [scored.grade]: s.counts[scored.grade] + 1 },
      ms: s.ms + ms,
    }));

    const actions = hand.drill.actions;
    const payload = {
      p_session_id: session.id,
      p_node_id: hand.drill.nodeId,
      p_combo: hand.entry.combo,
      p_board: hand.drill.context.board,
      p_actions: actions.map(({ id, label, kind, sizePct, color }) => ({ id, label, kind, sizePct: sizePct ?? null, color })),
      p_freqs: hand.entry.vector,
      p_rng: hand.rng,
      p_expected_action_id: actions[scored.expectedIndex]?.id ?? "",
      p_chosen_action_id: actions[index].id,
      p_chosen_freq: Math.round(scored.chosenFreq * 1000) / 1000,
      p_grade: scored.grade,
      p_answered_ms: ms,
    };
    // Straight to Supabase from the browser (RLS applies), one call per hand,
    // chained so answers land in order; a failure is retried on the next one.
    setUnsynced((u) => u + 1);
    const send = async (attempt = 0): Promise<void> => {
      const { error: rpcError } = await supabase.rpc("record_answer", payload);
      if (!rpcError) {
        setUnsynced((u) => u - 1);
        return;
      }
      if (attempt < 3) {
        await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
        return send(attempt + 1);
      }
      setError(`An answer could not be saved: ${rpcError.message}`);
    };
    writes.current = writes.current.then(() => send());
  }

  async function end() {
    if (!session) return;
    setPhase("ending");
    await writes.current;
    const r = await endSession(session.id);
    if (!r.ok) setError(r.error);
    setPhase("ended");
    router.refresh();
  }

  // Keyboard: 1…n answer, Space / Enter / → next hand.
  const chooseRef = useRef(choose);
  useEffect(() => {
    chooseRef.current = choose;
  });
  useEffect(() => {
    if (phase !== "playing") return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (!answer) {
        const n = Number(e.key);
        if (n >= 1 && hand && n <= hand.drill.actions.length) {
          e.preventDefault();
          chooseRef.current(n - 1);
        }
      } else if (e.key === " " || e.key === "Enter" || e.key === "ArrowRight") {
        e.preventDefault();
        if (session) deal(session.drill, pools);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, answer, hand, session, deal, pools]);

  const score = sessionScore(stats.hands, stats.correct);

  if (phase === "idle" || phase === "starting") {
    return (
      <div className="rounded-lg border border-line bg-surface p-6 text-center">
        <p className="text-sm text-muted">
          {nodeCount === 0
            ? "No node yet. Open Solver notes, select a strategy node and use “Add to trainer…”."
            : `${nodeCount} node${nodeCount > 1 ? "s" : ""} · ${trainer.hero_seat} vs ${trainer.villain_seat} · pot ${fmt(Number(trainer.pot_bb))} bb`}
        </p>
        {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
        <button
          type="button"
          disabled={nodeCount === 0 || phase === "starting"}
          onClick={() => void start()}
          className="mt-4 rounded bg-accent px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {phase === "starting" ? "Dealing…" : "Start a session"}
        </button>
        <p className="mt-3 text-[11px] text-muted">
          Each hand shows a number 0–99. Play the action whose band holds it: bands follow the buttons left to right.
        </p>
      </div>
    );
  }

  if (phase === "ended" || phase === "ending") {
    return (
      <div className="rounded-lg border border-line bg-surface p-6 text-center">
        <p className="text-xs uppercase tracking-wide text-muted">Session over</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums">{score === null ? "—" : `${Math.round(score)}%`}</p>
        <p className="mt-1 text-sm text-muted">
          {stats.correct} / {stats.hands} correct · {stats.counts.blunder} blunder{stats.counts.blunder === 1 ? "" : "s"}
        </p>
        <GradeCounts counts={stats.counts} />
        <div className="mt-4 flex justify-center gap-3">
          <button
            type="button"
            disabled={phase === "ending"}
            onClick={() => void start()}
            className="rounded bg-accent px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            New session
          </button>
          {session && stats.hands > 0 && (
            <Link
              href={`/poker/trainers/${trainer.id}/sessions/${session.id}`}
              className="rounded border border-line px-4 py-2 text-sm hover:border-accent"
            >
              Review hands
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    // Phones: the drill takes the whole screen (over the site header) and never
    // scrolls — bar, table sized to what is left, actions. From `sm` it stays
    // inline in the page.
    <div className="flex flex-col gap-2 max-sm:fixed max-sm:inset-0 max-sm:z-50 max-sm:overscroll-none max-sm:bg-background max-sm:px-3 max-sm:pt-[max(0.5rem,env(safe-area-inset-top))] max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:gap-3">
      {/* Session bar */}
      <div className="flex shrink-0 items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs sm:gap-x-4 sm:py-2">
        <span>
          <span className="text-muted">Hands</span> <b className="tabular-nums">{stats.hands}</b>
        </span>
        <span>
          <span className="text-muted">Correct</span>{" "}
          <b className="tabular-nums">{score === null ? "—" : `${Math.round(score)}%`}</b>
        </span>
        <span>
          <span className="text-muted">
            <span className="sm:hidden">Blund.</span>
            <span className="hidden sm:inline">Blunders</span>
          </span>{" "}
          <b className="tabular-nums">{stats.counts.blunder}</b>
        </span>
        {stats.hands > 0 && (
          <span className="hidden sm:inline">
            <span className="text-muted">Avg</span>{" "}
            <b className="tabular-nums">{(stats.ms / stats.hands / 1000).toFixed(1)}s</b>
          </span>
        )}
        {unsynced > 0 && <span className="hidden text-amber-600 sm:inline">saving…</span>}
        <button
          type="button"
          onClick={() => void end()}
          className="ml-auto shrink-0 rounded border border-line px-3 py-1 hover:border-red-500 hover:text-red-500"
        >
          End
          <span className="hidden sm:inline"> session</span>
        </button>
      </div>

      {notices.length > 0 && (
        <button
          type="button"
          onClick={() => setNotices([])}
          className="shrink-0 rounded border border-line px-3 py-1.5 text-left text-[11px] text-muted"
          title="Dismiss"
        >
          {notices.map((n) => (
            <span key={n} className="block truncate">
              {n}
            </span>
          ))}
        </button>
      )}
      {error && <p className="shrink-0 text-xs text-red-500">{error}</p>}

      {hand && (
        <>
          <div className="flex shrink-0 flex-col gap-x-2 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0 truncate">
              {hand.drill.spotName}
              {hand.drill.label ? ` · ${hand.drill.label}` : ""}
            </span>
            <span className="min-w-0 truncate sm:shrink-0">
              {hand.scene.line.length > 0
                ? hand.scene.line
                    .map((a) => `${a.seat} ${a.label.toLowerCase()}${a.amountBb != null ? ` (${fmt(a.amountBb)})` : ""}`)
                    .join(" · ")
                : "First to act"}
            </span>
          </div>

          <div className="flex items-center justify-center max-sm:min-h-0 max-sm:flex-1 max-sm:[container-type:size]">
            <PokerTable scene={hand.scene} combo={hand.entry.combo} fit />
          </div>

          {/* RNG + actions */}
          <div className="flex shrink-0 gap-2">
            <RngBadge value={hand.rng} />
            <div
              className="grid flex-1 gap-2"
              style={{ gridTemplateColumns: `repeat(${Math.min(hand.scene.actions.length, 4)}, minmax(0, 1fr))` }}
            >
              {hand.scene.actions.map((a, i) => {
                const picked = answer?.chosenIndex === i;
                const expected = answer?.scored.expectedIndex === i;
                return (
                  <button
                    key={a.id}
                    type="button"
                    disabled={!!answer}
                    onClick={() => choose(i)}
                    className={[
                      "relative touch-manipulation rounded-lg px-2 py-3 text-sm font-semibold text-white shadow transition",
                      answer && !picked && !expected ? "opacity-40" : "",
                      expected ? "ring-4 ring-emerald-400" : "",
                      picked && !expected ? "ring-4 ring-red-500" : "",
                    ].join(" ")}
                    style={{ backgroundColor: a.color }}
                  >
                    <span className="absolute left-1.5 top-1 hidden text-[10px] font-normal opacity-70 sm:inline">{i + 1}</span>
                    {a.label}
                    {a.amountBb != null && (
                      <span className="block text-[11px] font-normal opacity-90">
                        {a.allIn ? "all-in " : ""}
                        {fmt(a.amountBb)} bb
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {answer && (
            <ResultModal
              hand={hand}
              answer={answer}
              stats={stats}
              saving={unsynced > 0}
              onNext={() => session && deal(session.drill, pools)}
              onQuit={() => void end()}
            />
          )}
        </>
      )}
    </div>
  );
}

function buildPools(drill: DrillNode[]): Map<string, ComboEntry[]> {
  const m = new Map<string, ComboEntry[]>();
  for (const d of drill) {
    const pool = comboPool(d.weights, d.actions.length, new Set(d.context.board)).filter(
      (e) => playableFreqs(e.vector) !== null,
    );
    m.set(d.nodeId, pool);
  }
  return m;
}

function RngBadge({ value }: { value: number }) {
  return (
    <div className="flex w-16 shrink-0 flex-col items-center justify-center rounded-lg border-2 border-foreground/80 bg-surface">
      <span className="text-[9px] uppercase tracking-wide text-muted">RNG</span>
      <span className="text-2xl font-bold tabular-nums leading-none">{value}</span>
    </div>
  );
}

export function GradeCounts({ counts }: { counts: Record<Grade, number> }) {
  return (
    <div className="mt-2 flex flex-wrap justify-center gap-1.5">
      {(Object.keys(GRADE_LABELS) as Grade[]).map((g) => (
        <span key={g} className={`rounded px-1.5 py-0.5 text-[11px] ${GRADE_STYLES[g]}`}>
          {GRADE_LABELS[g]} {counts[g]}
        </span>
      ))}
    </div>
  );
}

/** The combo's bands as one bar in the button colours, with the roll marked. */
export function BandBar({
  vector,
  colors,
  labels,
  rng,
}: {
  vector: number[];
  colors: string[];
  labels: string[];
  rng: number;
}) {
  const play = playableFreqs(vector) ?? vector.map(() => 0);
  const b = bands(play);
  return (
    <div>
      <div className="relative flex h-7 overflow-hidden rounded">
        {play.map((f, i) =>
          b[i].end > b[i].start ? (
            <div
              key={i}
              className="flex items-center justify-center overflow-hidden text-[10px] font-medium text-white"
              style={{ width: `${b[i].end - b[i].start}%`, backgroundColor: colors[i] }}
              title={`${labels[i]} ${b[i].start}–${b[i].end - 1}`}
            >
              {b[i].end - b[i].start >= 12 ? labels[i] : ""}
            </div>
          ) : null,
        )}
        <div className="absolute inset-y-0 w-0.5 bg-black dark:bg-white" style={{ left: `${rng + 0.5}%` }} />
      </div>
      <div className="relative mt-0.5 h-4 text-[10px] tabular-nums text-muted">
        <span className="absolute -translate-x-1/2 font-semibold text-foreground" style={{ left: `${rng + 0.5}%` }}>
          {rng}
        </span>
      </div>
    </div>
  );
}

/**
 * The one popup after an answer: grade, the combo's bands with the roll, the
 * frequencies, the node's range, and Next hand / Quit. A bottom sheet on
 * phones, a centred dialog from `sm`.
 */
function ResultModal({
  hand,
  answer,
  stats,
  saving,
  onNext,
  onQuit,
}: {
  hand: Hand;
  answer: Answer;
  stats: Stats;
  saving: boolean;
  onNext: () => void;
  onQuit: () => void;
}) {
  const { actions, weights, context } = hand.drill;
  const norm = normalize(hand.entry.vector) ?? [];
  const play = playableFreqs(hand.entry.vector) ?? [];
  const b = bands(play);
  const grade = answer.scored.grade;
  const expected = actions[answer.scored.expectedIndex];
  const hand169 = comboToHand(hand.entry.combo);
  const cards = [...comboCards(hand.entry.combo)];
  const score = sessionScore(stats.hands, stats.correct);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={GRADE_LABELS[grade]}
    >
      <div className="flex max-h-[100dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:max-h-[90dvh] sm:max-w-2xl sm:rounded-2xl">
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_15rem]">
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <span className={`rounded-md px-2.5 py-1 text-sm font-semibold ${GRADE_STYLES[grade]}`}>
                  {GRADE_LABELS[grade]}
                </span>
                <BoardCards cards={cards} size="xs" />
                <span className="text-xs text-muted">{hand169}</span>
              </div>
              <p className="text-sm">
                Roll <b className="tabular-nums">{hand.rng}</b> → <b>{expected?.label}</b>.
                {grade !== "correct" && (
                  <span className="text-muted">
                    {" "}
                    You played {actions[answer.chosenIndex].label} (
                    {fmt(Math.round(answer.scored.chosenFreq * 10) / 10)}%).
                  </span>
                )}
              </p>
              <BandBar
                vector={hand.entry.vector}
                colors={actions.map((a) => a.color)}
                labels={actions.map((a) => a.label)}
                rng={hand.rng}
              />
              <table className="w-full text-xs">
                <tbody>
                  {actions.map((a, i) => (
                    <tr key={a.id} className={i === answer.scored.expectedIndex ? "font-semibold" : ""}>
                      <td className="py-0.5">
                        <span
                          className="mr-1.5 inline-block size-2.5 rounded-sm align-middle"
                          style={{ backgroundColor: a.color }}
                        />
                        {a.label}
                        {i === answer.chosenIndex && i !== answer.scored.expectedIndex && (
                          <span className="ml-1 font-normal text-red-500">· you</span>
                        )}
                      </td>
                      <td className="py-0.5 text-right tabular-nums">{fmt(Math.round((norm[i] ?? 0) * 10) / 10)}%</td>
                      <td className="py-0.5 pl-3 text-right tabular-nums text-muted">
                        {b[i] && b[i].end > b[i].start ? `${b[i].start}–${b[i].end - 1}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Capped by the screen height on phones so the sheet fits without scrolling. */}
            <div className="mx-auto w-full max-w-[min(100%,32dvh)] sm:max-w-none">
              <p className="mb-1 text-[11px] text-muted">{hand169} in the node&apos;s range</p>
              <StrategyGrid actions={actions} weights={weights} dead={new Set(context.board)} hovered={hand169} />
            </div>
          </div>
        </div>

        <div className="shrink-0 border-t border-line px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <p className="mb-2 text-center text-[11px] text-muted tabular-nums">
            Session: {stats.correct} / {stats.hands} correct
            {score !== null ? ` · ${Math.round(score)}%` : ""}
            {saving ? " · saving…" : ""}
          </p>
          <div className="grid grid-cols-[auto_1fr] gap-2">
            <button
              type="button"
              onClick={onQuit}
              className="rounded-lg border border-line px-4 py-2.5 text-sm hover:border-red-500 hover:text-red-500"
            >
              Quit
            </button>
            <button
              type="button"
              onClick={onNext}
              className="rounded-lg bg-accent py-2.5 text-sm font-medium text-white"
            >
              Next hand <span className="hidden opacity-70 sm:inline">(space)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
