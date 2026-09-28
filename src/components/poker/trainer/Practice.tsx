"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { comboCards, comboToHand } from "@/lib/solver/cards";
import { fmtBb, totalPot } from "@/lib/solver/gameState";
import { asMeta, type PokerNode, STREET_LABELS } from "@/lib/solver/types";
import { StrategyGrid } from "@/components/poker/StrategyGrid";
import { Markdown } from "@/components/poker/Markdown";
import { pickWeighted } from "@/lib/trainer/deal";
import { answer, buildTree, handScore, startHand, type Decision, type Hand, type Tree } from "@/lib/trainer/play";
import { sceneFromState, type Scene } from "@/lib/trainer/scene";
import { framesAfter, type Frame } from "@/lib/trainer/replay";
import { bands, normalize, playableFreqs, sessionScore } from "@/lib/trainer/score";
import { entryLabel, streetLines, toLine } from "@/lib/trainer/labels";
import { END_LABELS, GRADE_LABELS, type Drill, type Grade, type Trainer } from "@/lib/trainer/types";
import { endSession, startSession } from "@/server/actions/trainers";
import { PokerTable } from "@/components/poker/trainer/PokerTable";
import { BoardCards, PlayingCard } from "@/components/poker/trainer/Cards";
import { GRADE_STYLES } from "@/components/poker/trainer/grades";

type Stats = {
  /** Decisions answered. */
  decisions: number;
  correct: number;
  counts: Record<Grade, number>;
  ms: number;
  /** Hands finished, and those with every decision correct. */
  hands: number;
  perfect: number;
};

const EMPTY_STATS: Stats = {
  decisions: 0,
  correct: 0,
  counts: { correct: 0, wrong_band: 0, mistake: 0, blunder: 0 },
  ms: 0,
  hands: 0,
  perfect: 0,
};

/**
 * `replay`: the table plays out what happened since hero's last decision.
 * `deciding`: hero must act. `feedback`: the answer's result. `over`: the hand's recap.
 */
type View = "replay" | "deciding" | "feedback" | "over";

/** Frames being played on the table, then what comes after them. */
type Replay = { frames: Frame[]; i: number; then: () => void };

type Session = { id: string; drill: Drill; trees: Map<string, Tree> };


const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(x < 10 ? 2 : 1).replace(/\.?0+$/, ""));

export function Practice({ trainer, entryCount }: { trainer: Trainer; entryCount: number }) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [phase, setPhase] = useState<"idle" | "starting" | "playing" | "ending" | "ended">("idle");
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [hand, setHand] = useState<Hand | null>(null);
  const [view, setView] = useState<View>("deciding");
  const [replay, setReplay] = useState<Replay | null>(null);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [unsynced, setUnsynced] = useState(0);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const askedAt = useRef(0);

  const opts = useMemo(() => ({ stopAtStreetEnd: trainer.stop_at_street_end }), [trainer.stop_at_street_end]);

  /**
   * Straight to Supabase from the browser (RLS applies), chained so writes
   * land in order — a hand after its answers; a failure is retried.
   */
  const rpc = useCallback(
    (fn: "record_answer" | "record_hand", payload: Record<string, unknown>) => {
      setUnsynced((u) => u + 1);
      const send = async (attempt = 0): Promise<void> => {
        const { error: rpcError } = await supabase.rpc(fn, payload);
        if (!rpcError) {
          setUnsynced((u) => u - 1);
          return;
        }
        if (attempt < 3) {
          await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
          return send(attempt + 1);
        }
        setError(`${fn === "record_hand" ? "A hand" : "An answer"} could not be saved: ${rpcError.message}`);
      };
      writes.current = writes.current.then(() => send());
    },
    [supabase],
  );

  const recordHand = useCallback(
    (sess: Session, h: Hand) => {
      const { decisions, correct } = handScore(h);
      setStats((s) => ({ ...s, hands: s.hands + 1, perfect: s.perfect + (decisions > 0 && correct === decisions ? 1 : 0) }));
      rpc("record_hand", {
        p_id: h.id,
        p_session_id: sess.id,
        p_entry_node_id: h.entryId,
        p_end_node_id: h.end?.nodeId ?? null,
        p_combo: h.combo,
        p_villain_combo: h.villainCombo,
        p_board: h.state.board,
        p_line: toLine(h.state.log),
        p_end_reason: h.end?.reason ?? "end_of_solution",
        p_decisions: decisions,
        p_correct: correct,
      });
    },
    [rpc],
  );

  // The replay's continuation lives in a ref: it must run once, however often React renders.
  const replayRef = useRef<Replay | null>(null);

  /** Play frames on the table, then `then` (right away when there is nothing to show). */
  const play = useCallback((frames: Frame[], then: () => void) => {
    if (frames.length === 0) {
      replayRef.current = null;
      setReplay(null);
      then();
      return;
    }
    const r = { frames, i: 0, then };
    replayRef.current = r;
    setView("replay");
    setReplay(r);
  }, []);

  const finishReplay = useCallback(() => {
    const r = replayRef.current;
    if (!r) return;
    replayRef.current = null;
    setReplay(null);
    r.then();
  }, []);

  useEffect(() => {
    if (!replay) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const ms = replay.frames[replay.i].ms * (reduce ? 0.5 : 1);
    const t = window.setTimeout(() => {
      if (replayRef.current !== replay) return;
      if (replay.i + 1 < replay.frames.length) {
        const next = { ...replay, i: replay.i + 1 };
        replayRef.current = next;
        setReplay(next);
      } else finishReplay();
    }, ms);
    return () => window.clearTimeout(t);
  }, [replay, finishReplay]);

  const deal = useCallback(
    (sess: Session) => {
      let h: Hand | null = null;
      // An entry can fail to start a hand (the tree changed mid-session): try others.
      for (let attempt = 0; attempt < 20 && !h; attempt++) {
        const entry = pickWeighted(sess.drill.entries, (e) => e.weight);
        const tree = entry ? sess.trees.get(entry.spotId) : undefined;
        if (entry && tree) h = startHand(tree, entry.nodeId, trainer.hero_seat, crypto.randomUUID(), opts);
      }
      if (!h) {
        setError("No hand could be dealt from this trainer's entries.");
        return;
      }
      setHand(h);
      // The tree ended before hero's first decision: still a hand, it says where the tree stops.
      if (h.end) recordHand(sess, h);
      const dealt = h;
      play(framesAfter(dealt, -1), () => {
        if (dealt.end) setView("over");
        else {
          setView("deciding");
          askedAt.current = performance.now();
        }
      });
    },
    [trainer.hero_seat, opts, recordHand, play],
  );

  /** Show what follows hero's last answer, then his next decision, the recap or the next hand. */
  const playOn = useCallback(
    (h: Hand, sess: Session) => {
      play(framesAfter(h, h.decisions.length - 1), () => {
        if (!h.end) {
          setView("deciding");
          askedAt.current = performance.now();
        } else if (trainer.feedback === "each") deal(sess);
        else setView("over");
      });
    },
    [play, deal, trainer.feedback],
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
    if (r.updated > 0) n.push(`${r.updated} entr${r.updated > 1 ? "ies" : "y"} updated from the tree.`);
    for (const s of r.skipped) n.push(`Skipped an entry: ${s.reason}`);
    setNotices(n);
    setStats(EMPTY_STATS);
    const trees = new Map<string, Tree>();
    for (const spot of Object.values(r.drill.spots)) {
      const t = buildTree(spot, r.drill.weights);
      if (t) trees.set(spot.spotId, t);
    }
    const sess: Session = { id: r.sessionId, drill: r.drill, trees };
    setSession(sess);
    setPhase("playing");
    deal(sess);
  }

  function choose(index: number) {
    if (view !== "deciding" || !hand?.pending || !session) return;
    const tree = session.trees.get(hand.spotId);
    if (!tree) return;
    const next = answer(tree, hand, index, opts);
    const d = next.decisions[next.decisions.length - 1];
    if (!d?.scored) return;
    const ms = Math.round(performance.now() - askedAt.current);
    const grade = d.scored.grade;
    setStats((s) => ({
      ...s,
      decisions: s.decisions + 1,
      correct: s.correct + (grade === "correct" ? 1 : 0),
      counts: { ...s.counts, [grade]: s.counts[grade] + 1 },
      ms: s.ms + ms,
    }));
    rpc("record_answer", {
      p_session_id: session.id,
      p_node_id: d.nodeId,
      p_combo: next.combo,
      p_board: d.state.board,
      p_actions: d.actions.map(({ id, label, kind, sizePct, sizeUnit, color }) => ({
        id,
        label,
        kind,
        sizePct: sizePct ?? null,
        sizeUnit: sizeUnit ?? null,
        color,
      })),
      p_freqs: d.vector,
      p_rng: d.rng,
      p_expected_action_id: d.actions[d.scored.expectedIndex]?.id ?? "",
      p_chosen_action_id: d.actions[index].id,
      p_chosen_freq: Math.round(d.scored.chosenFreq * 1000) / 1000,
      p_grade: grade,
      p_answered_ms: ms,
      p_hand_id: next.id,
      p_step: next.decisions.length - 1,
      p_line: toLine(d.state.log),
      p_pot_bb: Math.round(totalPot(d.state) * 1000) / 1000,
    });
    if (next.end) recordHand(session, next);
    setHand(next);
    if (trainer.feedback === "each") setView("feedback");
    else playOn(next, session);
  }

  /** Continue after a result or a recap: the rest of the hand, or a new one. */
  const proceed = useCallback(() => {
    if (!session || !hand) return;
    if (view === "feedback") playOn(hand, session);
    else if (view === "replay") finishReplay();
    else if (hand.end) deal(session);
  }, [session, hand, view, deal, playOn, finishReplay]);

  async function end() {
    if (!session) return;
    replayRef.current = null;
    setReplay(null);
    setPhase("ending");
    await writes.current;
    const r = await endSession(session.id);
    if (!r.ok) setError(r.error);
    setPhase("ended");
    router.refresh();
  }

  // Keyboard: 1…n answer, Space / Enter / → continue.
  const chooseRef = useRef(choose);
  useEffect(() => {
    chooseRef.current = choose;
  });
  useEffect(() => {
    if (phase !== "playing") return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.tagName === "SUMMARY")) return;
      if (view === "deciding") {
        const n = Number(e.key);
        if (n >= 1 && hand?.pending && n <= hand.pending.actions.length) {
          e.preventDefault();
          chooseRef.current(n - 1);
        }
      } else if (e.key === " " || e.key === "Enter" || e.key === "ArrowRight") {
        e.preventDefault();
        proceed();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, view, hand, proceed]);

  const score = sessionScore(stats.decisions, stats.correct);
  const tree = hand && session ? session.trees.get(hand.spotId) : undefined;
  const last = hand ? hand.decisions[hand.decisions.length - 1] : undefined;

  // The table: the decision being asked, the one just answered, or the end of the hand.
  const frame = replay ? replay.frames[replay.i] : null;
  const scene: Scene | null = useMemo(() => {
    if (!hand || !tree) return null;
    const shown = view === "deciding" ? hand.pending : view === "feedback" ? last : null;
    return sceneFromState({
      state: frame ? frame.state : shown ? shown.state : hand.state,
      heroSeat: hand.heroSeat,
      villainSeat: hand.villainSeat,
      stackBb: tree.setup.stackBb,
      heroActions: !frame && shown ? shown.actions : [],
    });
  }, [hand, tree, view, last, frame]);

  if (phase === "idle" || phase === "starting") {
    return (
      <div className="rounded-lg border border-line bg-surface p-6 text-center">
        <p className="text-sm text-muted">
          {entryCount === 0
            ? "No entry yet. Open Solver notes, select a node and use “Train from here…”."
            : `${entryCount} entr${entryCount > 1 ? "ies" : "y"} · hero ${trainer.hero_seat} vs ${trainer.villain_seat}`}
        </p>
        {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
        <button
          type="button"
          disabled={entryCount === 0 || phase === "starting"}
          onClick={() => void start()}
          className="mt-4 rounded bg-accent px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {phase === "starting" ? "Dealing…" : "Start a session"}
        </button>
        <p className="mt-3 text-[11px] text-muted">
          Each hand is played down the tree until it ends. Every decision shows a number 0–99: play the action whose
          band holds it — bands follow the buttons left to right.
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
          {stats.correct} / {stats.decisions} decisions correct · {stats.perfect} / {stats.hands} perfect hands ·{" "}
          {stats.counts.blunder} blunder{stats.counts.blunder === 1 ? "" : "s"}
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
          {session && stats.hands + stats.decisions > 0 && (
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

  const showdown =
    hand?.end && (hand.end.reason === "showdown" || hand.end.reason === "allin") && (!frame || frame.end) ? hand.villainCombo : null;
  // Who wins without showdown, once the table gets there.
  const shownState = frame ? frame.state : view === "over" ? hand?.state : null;
  const winner = shownState?.terminal?.kind === "fold" && (!frame || frame.end) ? shownState.terminal.winner : null;
  const toAct = frame ? (frame.end ? null : frame.state.toAct) : view === "deciding" ? (hand?.heroSeat ?? null) : null;

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
          <span className="text-muted">Perfect</span>{" "}
          <b className="tabular-nums">{stats.hands ? `${Math.round((stats.perfect / stats.hands) * 100)}%` : "—"}</b>
        </span>
        <span className="hidden sm:inline">
          <span className="text-muted">Blunders</span> <b className="tabular-nums">{stats.counts.blunder}</b>
        </span>
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

      {hand && scene && tree && (
        <>
          <div className="flex shrink-0 flex-col gap-x-2 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0 truncate">
              {session?.drill.spots[hand.spotId]?.spotName}
              {tree.byId.get(hand.entryId) ? ` · from ${entryLabel(tree.byId.get(hand.entryId) as PokerNode)}` : ""}
              {hand.decisions.length > 0 ? ` · decision ${hand.decisions.length + (view === "deciding" ? 1 : 0)}` : ""}
            </span>
            <span className="min-w-0 truncate sm:shrink-0">{frame ? "" : logLine(scene)}</span>
          </div>

          <div
            className="flex cursor-default items-center justify-center max-sm:min-h-0 max-sm:flex-1 max-sm:[container-type:size]"
            onClick={frame ? finishReplay : undefined}
          >
            <PokerTable
              scene={scene}
              combo={hand.combo}
              villainCombo={showdown}
              fit
              handKey={hand.id}
              bubble={frame?.bubble ?? null}
              sweep={frame?.sweep ?? false}
              dealt={frame?.dealt ?? []}
              toAct={toAct}
              winner={winner}
            />
          </div>

          {/* RNG + actions; while the table plays out, what is happening */}
          {frame && replay ? (
            <ReplayBar frame={frame} index={replay.i} count={replay.frames.length} onSkip={finishReplay} />
          ) : (view === "deciding" && hand.pending) || (view === "feedback" && last) ? (
            <div key={`${hand.id}-${hand.decisions.length}`} className={view === "deciding" ? "trn-rise" : ""}>
              <ActionRow
                decision={view === "deciding" ? (hand.pending as Decision) : (last as Decision)}
                scene={scene}
                answered={view === "feedback"}
                onChoose={choose}
              />
            </div>
          ) : (
            <div className="shrink-0 py-3 text-center text-xs text-muted">{hand.end ? END_LABELS[hand.end.reason] : ""}</div>
          )}

          {view === "feedback" && last && (
            <DecisionModal
              hand={hand}
              decision={last}
              tree={tree}
              stats={stats}
              saving={unsynced > 0}
              onNext={proceed}
              onQuit={() => void end()}
            />
          )}
          {view === "over" && (
            <HandModal hand={hand} tree={tree} stats={stats} saving={unsynced > 0} onNext={proceed} onQuit={() => void end()} />
          )}
        </>
      )}
    </div>
  );
}

/** "BB check · BTN bet 1.82" for the current street, with earlier streets folded in front. */
function logLine(scene: Scene): string {
  const current = scene.line.filter((l) => l.street === scene.street);
  if (current.length === 0) return scene.line.length > 0 ? `${STREET_LABELS[scene.street]}: first to act` : "First to act";
  return current
    .map((a) => `${a.seat} ${a.label.toLowerCase()}${a.amountBb != null ? ` (${fmt(a.amountBb)})` : ""}`)
    .join(" · ");
}

function ActionRow({
  decision,
  scene,
  answered,
  onChoose,
}: {
  decision: Decision;
  scene: Scene;
  answered: boolean;
  onChoose: (i: number) => void;
}) {
  return (
    <div className="flex shrink-0 gap-2">
      <RngBadge value={decision.rng} />
      <div
        className="grid flex-1 gap-2"
        style={{ gridTemplateColumns: `repeat(${Math.min(scene.actions.length, 4)}, minmax(0, 1fr))` }}
      >
        {scene.actions.map((a, i) => {
          const picked = answered && decision.chosenIndex === i;
          const expected = answered && decision.scored?.expectedIndex === i;
          return (
            <button
              key={a.id}
              type="button"
              disabled={answered}
              onClick={() => onChoose(i)}
              className={[
                "relative touch-manipulation rounded-lg px-2 py-3 text-sm font-semibold text-white shadow transition",
                answered && !picked && !expected ? "opacity-40" : "",
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
  );
}

/** Under the table while it plays out: what is happening, and a way to skip. Same height as the action row. */
function ReplayBar({ frame, index, count, onSkip }: { frame: Frame; index: number; count: number; onSkip: () => void }) {
  return (
    <div className="flex h-[3.75rem] shrink-0 items-center gap-3 rounded-lg border border-line bg-surface px-3">
      <div className="min-w-0 flex-1">
        <p key={`${index}-${frame.caption}`} className="trn-pop truncate text-sm font-semibold">
          {frame.caption}
        </p>
        <div className="mt-1 flex gap-1" aria-hidden>
          {Array.from({ length: count }, (_, i) => (
            <span key={i} className={`h-1 w-4 rounded-full transition-colors ${i <= index ? "bg-accent" : "bg-foreground/10"}`} />
          ))}
        </div>
      </div>
      <button
        type="button"
        onClick={onSkip}
        className="shrink-0 rounded-md border border-line px-3 py-1.5 text-xs text-muted hover:border-accent hover:text-foreground"
      >
        Skip <span className="hidden opacity-70 sm:inline">(space)</span>
      </button>
    </div>
  );
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

/** How the hand ended, in one sentence. */
export function endSentence(hand: Hand): string {
  const end = hand.end;
  if (!end) return "";
  const t = hand.state.terminal;
  switch (end.reason) {
    case "fold":
      if (t?.kind === "fold") {
        const loser = t.winner === hand.heroSeat ? hand.villainSeat : hand.heroSeat;
        return `${loser === hand.heroSeat ? "You fold" : `${loser} folds`} — ${t.winner === hand.heroSeat ? "you win" : `${t.winner} wins`} ${fmtBb(t.potBb)} bb.`;
      }
      return "Hand over.";
    case "showdown":
      return `Showdown — pot ${fmtBb(t?.potBb ?? totalPot(hand.state))} bb.`;
    case "allin":
      return `All-in and called — pot ${fmtBb(t?.potBb ?? totalPot(hand.state))} bb.`;
    case "end_of_solution":
      return "End of solution: the tree has nothing after this point.";
    case "branch_not_developed":
      return "Branch not developed: your option has no branch in the tree.";
    case "off_range":
      return "Off range: the solution has no strategy for this hand here.";
    case "no_runout":
      return "No runout in the tree is possible with your cards.";
    case "end_of_street":
      return "End of street: the betting round is over.";
  }
}

/** A node's summary and notes, as written in Solver notes. */
function NodeNotesBlock({ node, open = false }: { node: PokerNode | undefined; open?: boolean }) {
  if (!node) return null;
  const { summary, notes } = asMeta(node);
  if (!summary && !notes.trim()) return null;
  return (
    <div className="rounded border border-line bg-background/50 px-2.5 py-2 text-xs">
      {summary && <p className="whitespace-pre-line font-medium">{summary}</p>}
      {notes.trim() && (
        <details open={open} className="mt-1">
          <summary className="cursor-pointer text-[11px] text-muted">Notes</summary>
          <div className="mt-1 text-xs">
            <Markdown source={notes} />
          </div>
        </details>
      )}
    </div>
  );
}

function DecisionResult({ decision, tree, compact = false }: { decision: Decision; tree: Tree; compact?: boolean }) {
  const { actions, vector, rng } = decision;
  const scored = decision.scored!;
  const norm = normalize(vector) ?? [];
  const play = playableFreqs(vector) ?? [];
  const b = bands(play);
  const expected = actions[scored.expectedIndex];
  const chosen = decision.chosenIndex ?? -1;
  return (
    <div className="space-y-2">
      <p className="text-sm">
        <span className={`mr-2 rounded px-1.5 py-0.5 text-xs font-semibold ${GRADE_STYLES[scored.grade]}`}>
          {GRADE_LABELS[scored.grade]}
        </span>
        Roll <b className="tabular-nums">{rng}</b> → <b>{expected?.label}</b>.
        {scored.grade !== "correct" && chosen >= 0 && (
          <span className="text-muted">
            {" "}
            You played {actions[chosen].label} ({fmt(Math.round(scored.chosenFreq * 10) / 10)}%).
          </span>
        )}
      </p>
      <BandBar vector={vector} colors={actions.map((a) => a.color)} labels={actions.map((a) => a.label)} rng={rng} />
      {!compact && (
        <table className="w-full text-xs">
          <tbody>
            {actions.map((a, i) => (
              <tr key={a.id} className={i === scored.expectedIndex ? "font-semibold" : ""}>
                <td className="py-0.5">
                  <span className="mr-1.5 inline-block size-2.5 rounded-sm align-middle" style={{ backgroundColor: a.color }} />
                  {a.label}
                  {i === chosen && i !== scored.expectedIndex && <span className="ml-1 font-normal text-red-500">· you</span>}
                </td>
                <td className="py-0.5 text-right tabular-nums">{fmt(Math.round((norm[i] ?? 0) * 10) / 10)}%</td>
                <td className="py-0.5 pl-3 text-right tabular-nums text-muted">
                  {b[i] && b[i].end > b[i].start ? `${b[i].start}–${b[i].end - 1}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <NodeNotesBlock node={tree.byId.get(decision.nodeId)} open={!compact} />
    </div>
  );
}

function ModalShell({
  label,
  children,
  footer,
}: {
  label: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div className="flex max-h-[100dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:max-h-[90dvh] sm:max-w-2xl sm:rounded-2xl">
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        <div className="shrink-0 border-t border-line px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>
      </div>
    </div>
  );
}

function ModalFooter({
  stats,
  saving,
  next,
  onNext,
  onQuit,
}: {
  stats: Stats;
  saving: boolean;
  next: string;
  onNext: () => void;
  onQuit: () => void;
}) {
  const score = sessionScore(stats.decisions, stats.correct);
  return (
    <>
      <p className="mb-2 text-center text-[11px] text-muted tabular-nums">
        Session: {stats.correct} / {stats.decisions} correct
        {score !== null ? ` · ${Math.round(score)}%` : ""} · {stats.hands} hand{stats.hands === 1 ? "" : "s"}
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
        <button type="button" onClick={onNext} className="rounded-lg bg-accent py-2.5 text-sm font-medium text-white">
          {next} <span className="hidden opacity-70 sm:inline">(space)</span>
        </button>
      </div>
    </>
  );
}

/**
 * After each answer (feedback "each"): the grade, the combo's bands with the
 * roll, the frequencies, the node's notes and range, then Continue — or Next
 * hand when that answer ended it.
 */
function DecisionModal({
  hand,
  decision,
  tree,
  stats,
  saving,
  onNext,
  onQuit,
}: {
  hand: Hand;
  decision: Decision;
  tree: Tree;
  stats: Stats;
  saving: boolean;
  onNext: () => void;
  onQuit: () => void;
}) {
  const weights = tree.weights[decision.nodeId];
  const hand169 = hand.combo ? comboToHand(hand.combo) : "";
  const cards = hand.combo ? [...comboCards(hand.combo)] : [];
  return (
    <ModalShell
      label={decision.scored ? GRADE_LABELS[decision.scored.grade] : "Result"}
      footer={
        <ModalFooter stats={stats} saving={saving} next={hand.end ? "Next hand" : "Continue"} onNext={onNext} onQuit={onQuit} />
      }
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_15rem]">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <BoardCards cards={cards} size="xs" />
            <span className="text-xs text-muted">{hand169}</span>
            <span className="text-xs text-muted">· decision {hand.decisions.length}</span>
          </div>
          <DecisionResult decision={decision} tree={tree} />
          {hand.end && <EndBanner hand={hand} />}
        </div>
        {weights && (
          <div className="mx-auto w-full max-w-[min(100%,32dvh)] sm:max-w-none">
            <p className="mb-1 text-[11px] text-muted">{hand169} in the node&apos;s range</p>
            <StrategyGrid actions={decision.actions} weights={weights} dead={new Set(decision.state.board)} hovered={hand169} />
          </div>
        )}
      </div>
    </ModalShell>
  );
}

function EndBanner({ hand }: { hand: Hand }) {
  const villain = hand.villainCombo ? comboCards(hand.villainCombo) : null;
  return (
    <div className="rounded-lg border border-line bg-background/50 px-3 py-2 text-sm">
      <p className="font-medium">{endSentence(hand)}</p>
      {villain && (
        <p className="mt-1 flex items-center gap-2 text-xs text-muted">
          {hand.villainSeat} shows
          <span className="flex gap-0.5">
            <PlayingCard card={villain[0]} size="sm" />
            <PlayingCard card={villain[1]} size="sm" />
          </span>
        </p>
      )}
    </div>
  );
}

/** The whole hand once it is over: how it ended, the line street by street, every decision graded. */
function HandModal({
  hand,
  tree,
  stats,
  saving,
  onNext,
  onQuit,
}: {
  hand: Hand;
  tree: Tree;
  stats: Stats;
  saving: boolean;
  onNext: () => void;
  onQuit: () => void;
}) {
  const { decisions, correct } = handScore(hand);
  const cards = hand.combo ? comboCards(hand.combo) : null;
  return (
    <ModalShell
      label={hand.end ? END_LABELS[hand.end.reason] : "Hand"}
      footer={<ModalFooter stats={stats} saving={saving} next="Next hand" onNext={onNext} onQuit={onQuit} />}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {cards && (
            <span className="flex gap-0.5">
              <PlayingCard card={cards[0]} size="sm" />
              <PlayingCard card={cards[1]} size="sm" />
            </span>
          )}
          <span className="text-sm">
            {decisions === 0 ? "No decision this hand" : `${correct} / ${decisions} correct`}
          </span>
          {decisions > 0 && correct === decisions && (
            <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">Perfect</span>
          )}
        </div>
        <EndBanner hand={hand} />
        <HandLine hand={hand} />
        {hand.decisions.map((d, i) =>
          d.scored ? (
            <div key={i} className="rounded-lg border border-line p-3">
              <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">
                Decision {i + 1} · {STREET_LABELS[d.state.street]} · pot {fmtBb(totalPot(d.state))}
              </p>
              <DecisionResult decision={d} tree={tree} compact />
            </div>
          ) : null,
        )}
        {hand.end && (hand.end.reason === "end_of_solution" || hand.end.reason === "branch_not_developed") && hand.end.nodeId && (
          <Link
            href={`/poker/spots/${hand.spotId}?node=${hand.end.nodeId}`}
            className="inline-block text-xs text-accent hover:underline"
          >
            Open where the tree stops →
          </Link>
        )}
      </div>
    </ModalShell>
  );
}

function HandLine({ hand }: { hand: Hand }) {
  const rows = streetLines(hand.state.log, hand.state.board);
  if (rows.length === 0) return null;
  const who = (seat: string) => (seat === hand.heroSeat ? "You" : seat);
  return (
    <div className="space-y-1 text-xs">
      {rows.map((r) => (
        <div key={r.street} className="grid grid-cols-[3.25rem_1fr] items-start gap-x-2">
          <span className="text-muted">{STREET_LABELS[r.street]}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {r.cards.length > 0 && <BoardCards cards={r.cards} size="xs" />}
            <span>
              {r.actions
                .map((a) => `${who(a.seat)} ${a.label.toLowerCase()}${a.amountBb != null && a.kind !== "call" ? ` (${fmt(a.amountBb)})` : ""}`)
                .join(" · ")}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
