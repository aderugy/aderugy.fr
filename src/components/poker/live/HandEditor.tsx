"use client";

import { useMemo, useState, useTransition } from "react";
import { CardGrid } from "./CardGrid";
import { FeltCenter, LiveTable, type SeatView } from "./LiveTable";
import { INPUT } from "./ui";
import { PlayingCard } from "@/components/poker/trainer/Cards";
import {
  behind,
  describeStep,
  foldsUntil,
  options,
  playHand,
  positions,
  potRaiseTo,
  settle,
  type HandState,
  type PlayResult,
} from "@/lib/live/hand";
import {
  BOARD_SIZE,
  STREET_LABELS,
  fmtChips,
  parseAmount,
  splitCards,
  type HandAction,
  type HandInput,
  type HandPost,
  type Street,
} from "@/lib/live/types";
import { computedHeroNet } from "@/lib/live/validate";

/** Who sits in a seat, for the editor; `known: false` for an unknown player. */
export type SeatName = { playerId: string | null; name: string | null; colors?: string[]; known?: boolean };

type Phase = "setup" | "action" | "result";
const PHASE_LABELS: Record<Phase, string> = { setup: "Setup", action: "Action", result: "Result" };

const r2 = (x: number) => Math.round(x * 100) / 100;

/** A blind bought back: the big blind live, or the big blind live and the small blind dead. */
type PostMode = "bb" | "both";

function postModes(posts: HandPost[] | undefined): Record<number, PostMode> {
  return Object.fromEntries((posts ?? []).map((p) => [p.seat, p.dead > 0 ? "both" : "bb"]));
}

/**
 * Enter a hand action by action, full screen. Setup (who is dealt in, the
 * button, blinds, your cards, stacks if known), then the action in turn
 * order with the board between streets, then the result: cards shown, who
 * took each pot, your net. Nothing is saved until Save.
 */
export function HandEditor({
  title,
  size,
  currency,
  heroSeat,
  names,
  initial,
  onSave,
  onClose,
}: {
  title: string;
  size: number;
  currency: string;
  heroSeat: number;
  names: Map<number, SeatName>;
  initial: HandInput;
  onSave: (input: HandInput) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>(initial.actions.length ? "result" : "setup");
  const [dealt, setDealt] = useState<number[]>(initial.seats.map((s) => s.seat).sort((a, b) => a - b));
  const [button, setButton] = useState(initial.button_seat);
  const [tapMode, setTapMode] = useState<"deal" | "button">("deal");
  const [sb, setSb] = useState(fmtChips(initial.small_blind));
  const [bb, setBb] = useState(fmtChips(initial.big_blind));
  const [straddle, setStraddle] = useState(initial.straddle ? fmtChips(initial.straddle) : "");
  const [postsBy, setPostsBy] = useState<Record<number, PostMode>>(postModes(initial.posts));
  const [stacks, setStacks] = useState<Record<number, string>>(
    Object.fromEntries(initial.seats.filter((s) => s.stack != null).map((s) => [s.seat, fmtChips(s.stack!)])),
  );
  const [heroCards, setHeroCards] = useState<string[]>(splitCards(initial.hero_cards) ?? []);
  const [actions, setActions] = useState<HandAction[]>(initial.actions);
  const [board, setBoard] = useState<string[]>(initial.board);
  const [skipped, setSkipped] = useState<Set<Street>>(new Set());
  /** Seats whose cards were not shown at showdown (mucked), so they are not asked for. */
  const [mucked, setMucked] = useState<Set<number>>(new Set());
  /** In the result: the board or a seat's shown cards being picked. */
  const [resultEditing, setResultEditing] = useState<"board" | number | null>(null);
  const [shown, setShown] = useState<Record<number, string[]>>(
    Object.fromEntries(Object.entries(initial.shown).map(([k, v]) => [Number(k), splitCards(v) ?? []])),
  );
  const [winners, setWinners] = useState<number[][]>(initial.winners);
  const [netOverride, setNetOverride] = useState<string>(initial.hero_net != null ? fmtChips(initial.hero_net) : "");
  const [starred, setStarred] = useState(initial.starred);
  const [notes, setNotes] = useState(initial.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const hero = dealt.includes(heroSeat) ? heroSeat : initial.hero_seat && dealt.includes(initial.hero_seat) ? initial.hero_seat : null;

  /* ------------------------------------------------------------ derived */

  const setupNums = {
    sb: parseAmount(sb),
    bb: parseAmount(bb),
    straddle: straddle.trim() ? parseAmount(straddle) : null,
  };
  const posts: HandPost[] = dealt
    .filter((seat) => postsBy[seat])
    .map((seat) => ({ seat, live: setupNums.bb ?? 0, dead: postsBy[seat] === "both" ? (setupNums.sb ?? 0) : 0 }));
  const seats = dealt.map((seat) => {
    const st = parseAmount(stacks[seat] ?? "");
    return { seat, player_id: names.get(seat)?.playerId ?? null, stack: st && st > 0 ? st : null };
  });

  // Replayed on every render: a hand is a few dozen actions at most.
  const play = ((): { result: PlayResult; error: null } | { result: null; error: string } => {
    try {
      if (!(setupNums.sb! > 0) || !(setupNums.bb! > 0)) return { result: null, error: "Set the blinds." };
      return {
        result: playHand({ seats, button, sb: setupNums.sb!, bb: setupNums.bb!, straddle: setupNums.straddle, posts }, actions),
        error: null,
      };
    } catch (e) {
      return { result: null, error: e instanceof Error ? e.message : String(e) };
    }
  })();

  const result = play.result;
  const state: HandState | null = result?.state ?? null;
  const pos = useMemo(() => positions(dealt, button), [dealt, button]);
  const settlement = state ? settle(state, winners) : null;
  const autoNet = settlement && hero !== null ? computedHeroNet({ settlement }, hero) : null;

  const usedCards = new Set<string>([...heroCards, ...board, ...Object.values(shown).flat()]);

  const needBoard =
    state && !state.end && board.length < BOARD_SIZE[state.street] && !skipped.has(state.street) ? state.street : null;

  // At showdown — on the river, or an all-in that runs the board out — ask
  // for the rest of the board, then the cards of each opponent still in.
  const atShowdown = state?.end?.reason === "showdown";
  const needRunout = atShowdown && board.length < 5 && !skipped.has("river");
  const needShown =
    atShowdown && !needRunout
      ? (state!.seats.find((x) => !x.folded && x.seat !== hero && (shown[x.seat]?.length ?? 0) < 2 && !mucked.has(x.seat))?.seat ?? null)
      : null;

  /* -------------------------------------------------------------- seats */

  function seatViews(): SeatView[] {
    const out: SeatView[] = [];
    for (let n = 1; n <= size; n++) {
      const nm = names.get(n);
      const isDealt = dealt.includes(n);
      const kind: SeatView["kind"] = n === hero || (!isDealt && n === heroSeat) ? "hero" : nm ? (nm.playerId && nm.known !== false ? "player" : "unknown") : isDealt ? "unknown" : "empty";
      const v: SeatView = { seat: n, kind, name: nm?.name ?? undefined, colors: nm?.colors, position: isDealt ? pos.get(n) : undefined };
      if (!isDealt) {
        v.out = true;
      } else if (phase === "setup" || !state) {
        const st = parseAmount(stacks[n] ?? "");
        v.sub = postsBy[n] ? (postsBy[n] === "both" ? "posts BB+SB" : "posts BB") : st ? fmtChips(st) : undefined;
        v.cards = n === hero && heroCards.length === 2 ? heroCards.join("") : null;
      } else {
        const s = state.seats.find((x) => x.seat === n)!;
        v.bet = s.street;
        v.out = s.folded;
        const left = behind(s);
        v.sub = s.allIn ? "all-in" : s.folded ? "folded" : left !== null ? fmtChips(left) : undefined;
        if (n === hero && heroCards.length === 2) v.cards = heroCards.join("");
        else if (shown[n]?.length === 2) v.cards = shown[n].join("");
        else v.hidden = !s.folded;
      }
      out.push(v);
    }
    return out;
  }

  function tapSeat(n: number) {
    setError(null);
    if (phase === "setup") {
      if (tapMode === "button") return setButton(n);
      setDealt((d) => (d.includes(n) ? d.filter((x) => x !== n) : [...d, n].sort((a, b) => a - b)));
      return;
    }
    if (phase === "result" && state) {
      const s = state.seats.find((x) => x.seat === n);
      if (s && !s.folded && n !== hero) setResultEditing((e) => (e === n ? null : n));
      return;
    }
    if (phase === "action" && state && !needBoard && state.toAct !== null && n !== state.toAct) {
      const folds = foldsUntil(state, n);
      if (folds) setActions((a) => [...a, ...folds]);
      else setError(`Seat ${n} does not act before the street ends.`);
    }
  }

  function push(a: HandAction) {
    setError(null);
    setActions((xs) => [...xs, a]);
  }

  function build(): HandInput {
    const heroNet = netOverride.trim() ? parseAmount(netOverride) : autoNet;
    return {
      button_seat: button,
      hero_seat: hero,
      small_blind: setupNums.sb ?? 0,
      big_blind: setupNums.bb ?? 0,
      straddle: setupNums.straddle,
      posts,
      seats,
      actions,
      hero_cards: heroCards.length === 2 ? heroCards.join("") : null,
      board,
      shown: Object.fromEntries(Object.entries(shown).filter(([, v]) => v.length === 2).map(([k, v]) => [k, v.join("")])),
      winners: settlement ? settlement.pots.map((p, i) => (p.eligible.length === 1 ? p.eligible : (winners[i] ?? []).filter((s) => p.eligible.includes(s)))) : [],
      hero_net: heroNet === null || Number.isNaN(heroNet) ? null : heroNet,
      starred,
      notes: notes.trim() || null,
    };
  }

  function save() {
    setError(null);
    if (!result) return setError(play.error ?? "Check the setup.");
    if (!result.ok) return setError(result.error ?? "An action does not fit.");
    startSaving(async () => {
      const r = await onSave(build());
      if (!r.ok) setError(r.error ?? "Could not save.");
      else onClose();
    });
  }

  /* ------------------------------------------------------------- render */

  const center =
    phase === "setup" ? (
      <FeltCenter board={[]} note={tapMode === "button" ? "Tap the button's seat" : "Tap seats to deal them in or out"} />
    ) : (
      <FeltCenter
        board={board}
        pot={state ? r2(state.pot + state.seats.reduce((t, s) => t + s.street, 0)) : null}
        note={
          state
            ? state.end
              ? state.end.reason === "fold"
                ? `${seatLabel(state.end.winner, pos, names, hero)} wins`
                : "Showdown"
              : STREET_LABELS[state.street]
            : null
        }
      />
    );

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <button type="button" onClick={onClose} className="text-sm text-muted hover:text-foreground">
          Cancel
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-sm font-semibold">{title}</div>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </header>
      <div className="flex shrink-0 border-b border-line text-xs">
        {(["setup", "action", "result"] as Phase[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPhase(p)}
            aria-pressed={phase === p}
            className={`flex-1 py-2 ${phase === p ? "border-b-2 border-accent font-semibold" : "text-muted"}`}
          >
            {PHASE_LABELS[p]}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-2 pt-2">
          <LiveTable
            size={size}
            seats={seatViews()}
            button={button}
            toAct={phase === "action" && !needBoard ? (state?.toAct ?? null) : null}
            center={center}
            onSeat={tapSeat}
          />
        </div>

        <div className="mx-auto max-w-xl space-y-4 px-4 pb-8 pt-2">
          {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
          {play.error && phase !== "setup" && <p className="text-sm text-red-500">{play.error}</p>}
          {result && !result.ok && <p className="text-sm text-red-500">Action {result.failedAt! + 1}: {result.error} — undo it or fix the setup.</p>}

          {phase === "setup" && (
            <SetupPanel
              tapMode={tapMode}
              setTapMode={setTapMode}
              dealt={dealt}
              pos={pos}
              names={names}
              hero={hero}
              sb={sb}
              bb={bb}
              straddle={straddle}
              setSb={setSb}
              setBb={setBb}
              setStraddle={setStraddle}
              postsBy={postsBy}
              setPostsBy={setPostsBy}
              stacks={stacks}
              setStacks={setStacks}
              heroCards={heroCards}
              setHeroCards={setHeroCards}
              used={usedCards}
              setupError={play.error}
              onNext={() => setPhase("action")}
            />
          )}

          {phase === "action" && state && (
            <>
              {needBoard ? (
                <BoardPrompt
                  key={needBoard}
                  street={needBoard}
                  board={board}
                  used={usedCards}
                  onChange={setBoard}
                  onSkip={() => setSkipped((s) => new Set(s).add(needBoard))}
                />
              ) : needRunout ? (
                <BoardPrompt
                  key={`runout-${board.length}`}
                  street="river"
                  title={board.length ? "Rest of the board" : "The board"}
                  from={board.length}
                  board={board}
                  used={usedCards}
                  onChange={setBoard}
                  onSkip={() => setSkipped((s) => new Set(s).add("river"))}
                />
              ) : needShown !== null ? (
                <ShownPrompt
                  key={`shown-${needShown}`}
                  label={seatLabel(needShown, pos, names, hero)}
                  used={usedCards}
                  onPick={(cards) => setShown((x) => ({ ...x, [needShown]: cards }))}
                  onMuck={() => setMucked((m) => new Set(m).add(needShown))}
                />
              ) : state.end ? (
                <div className="rounded-lg border border-line bg-surface p-3 text-sm">
                  <p className="font-medium">
                    {state.end.reason === "fold"
                      ? `Everyone else folded: ${seatLabel(state.end.winner, pos, names, hero)} takes it.`
                      : state.end.runout
                        ? "All-in: the board runs out."
                        : "Showdown."}
                  </p>
                  <button type="button" onClick={() => setPhase("result")} className="mt-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white">
                    Result →
                  </button>
                </div>
              ) : (
                <ActionPanel
                  key={`${actions.length}`}
                  state={state}
                  label={(s) => seatLabel(s, pos, names, hero)}
                  currency={currency}
                  onAct={push}
                />
              )}
              <ActionLog
                result={result!}
                label={(s) => seatLabel(s, pos, names, hero)}
                onUndo={actions.length ? () => setActions((a) => a.slice(0, -1)) : undefined}
              />
            </>
          )}

          {phase === "result" && state && settlement && (
            <ResultPanel
              editing={resultEditing}
              setEditing={setResultEditing}
              state={state}
              settlement={settlement}
              winners={winners}
              setWinners={setWinners}
              board={board}
              setBoard={setBoard}
              shown={shown}
              setShown={setShown}
              hero={hero}
              used={usedCards}
              label={(s) => seatLabel(s, pos, names, hero)}
              autoNet={autoNet}
              netOverride={netOverride}
              setNetOverride={setNetOverride}
              currency={currency}
              starred={starred}
              setStarred={setStarred}
              notes={notes}
              setNotes={setNotes}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function seatLabel(seat: number, pos: Map<number, string>, names: Map<number, SeatName>, hero: number | null): string {
  const who = seat === hero ? "You" : (names.get(seat)?.name ?? `Seat ${seat}`);
  const p = pos.get(seat);
  return p ? `${who} (${p})` : who;
}

/* --------------------------------------------------------------- setup */

function SetupPanel(props: {
  tapMode: "deal" | "button";
  setTapMode: (m: "deal" | "button") => void;
  dealt: number[];
  pos: Map<number, string>;
  names: Map<number, SeatName>;
  hero: number | null;
  sb: string;
  bb: string;
  straddle: string;
  setSb: (v: string) => void;
  setBb: (v: string) => void;
  setStraddle: (v: string) => void;
  postsBy: Record<number, PostMode>;
  setPostsBy: (f: (p: Record<number, PostMode>) => Record<number, PostMode>) => void;
  stacks: Record<number, string>;
  setStacks: (f: (s: Record<number, string>) => Record<number, string>) => void;
  heroCards: string[];
  setHeroCards: (c: string[]) => void;
  used: Set<string>;
  setupError: string | null;
  onNext: () => void;
}) {
  // Open by default: stacks matter (all-ins, effective stacks) and come prefilled from the table.
  const [showStacks, setShowStacks] = useState(true);
  const [showPosts, setShowPosts] = useState(Object.keys(props.postsBy).length > 0);
  // Anyone dealt in but the blinds may be buying them back.
  // (A seat already marked stays listed, so a mark that no longer fits can be cleared.)
  const canPost = props.dealt.filter((s) => (props.pos.get(s) !== "SB" && props.pos.get(s) !== "BB") || props.postsBy[s]);
  const cyclePost = (seat: number) =>
    props.setPostsBy((p) => {
      const next = { ...p };
      if (!p[seat]) next[seat] = "bb";
      else if (p[seat] === "bb") next[seat] = "both";
      else delete next[seat];
      return next;
    });
  return (
    <>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted">Tap a seat to</span>
        {(["deal", "button"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => props.setTapMode(m)}
            className={`rounded-full border px-2.5 py-1 ${props.tapMode === m ? "border-accent bg-accent text-white" : "border-line"}`}
          >
            {m === "deal" ? "deal in / out" : "move the button"}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">
        {props.dealt.length} dealt in · {props.dealt.map((s) => `${s}${props.pos.get(s) ? ` ${props.pos.get(s)}` : ""}`).join(" · ")}
      </p>

      <section>
        <h3 className="mb-1 flex items-center gap-2 text-xs font-medium tracking-wide text-muted uppercase">
          Your cards
          <span className="flex gap-0.5 normal-case">
            {props.heroCards.map((c) => (
              <PlayingCard key={c} card={c} size="xs" />
            ))}
          </span>
          {props.heroCards.length > 0 && (
            <button type="button" onClick={() => props.setHeroCards([])} className="ml-auto text-[11px] normal-case">
              clear
            </button>
          )}
        </h3>
        {props.hero === null ? (
          <p className="text-xs text-muted">You are not dealt in.</p>
        ) : (
          <CardGrid count={2} selected={props.heroCards} dead={props.used} onChange={props.setHeroCards} />
        )}
      </section>

      <section className="grid grid-cols-3 gap-2">
        <label className="text-xs text-muted">
          SB
          <input inputMode="decimal" onFocus={(e) => e.currentTarget.select()} value={props.sb} onChange={(e) => props.setSb(e.target.value)} className={INPUT} />
        </label>
        <label className="text-xs text-muted">
          BB
          <input inputMode="decimal" onFocus={(e) => e.currentTarget.select()} value={props.bb} onChange={(e) => props.setBb(e.target.value)} className={INPUT} />
        </label>
        <label className="text-xs text-muted">
          Straddle
          <input inputMode="decimal" onFocus={(e) => e.currentTarget.select()} value={props.straddle} placeholder="—" onChange={(e) => props.setStraddle(e.target.value)} className={INPUT} />
        </label>
      </section>

      <section>
        <button type="button" onClick={() => setShowStacks((s) => !s)} className="text-xs text-muted">
          {showStacks ? "▾" : "▸"} Stacks — from the table, change them if needed
        </button>
        {showStacks && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            {props.dealt.map((s) => (
              <label key={s} className="text-xs text-muted">
                {s === props.hero ? "You" : (props.names.get(s)?.name ?? `Seat ${s}`)} · {s}
                <input
                  inputMode="decimal" onFocus={(e) => e.currentTarget.select()}
                  value={props.stacks[s] ?? ""}
                  placeholder="?"
                  onChange={(e) => props.setStacks((x) => ({ ...x, [s]: e.target.value }))}
                  className={INPUT}
                />
              </label>
            ))}
          </div>
        )}
      </section>

      <section>
        <button type="button" onClick={() => setShowPosts((s) => !s)} className="text-xs text-muted">
          {showPosts ? "▾" : "▸"} Blinds bought back
          {Object.keys(props.postsBy).length > 0 ? ` · ${Object.keys(props.postsBy).length}` : ""}
        </button>
        {showPosts && (
          <>
            <p className="mt-1 text-[11px] text-muted">
              Back from missing the blinds? Tap their seat: posts the big blind (live, they keep the option), tap again for big blind + small blind
              dead, again to clear.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {canPost.map((s) => {
                const mode = props.postsBy[s];
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => cyclePost(s)}
                    aria-pressed={Boolean(mode)}
                    className={`rounded-full border px-2.5 py-1 text-xs ${mode ? "border-accent bg-accent text-white" : "border-line"}`}
                  >
                    {s === props.hero ? "You" : (props.names.get(s)?.name ?? `Seat ${s}`)} · {s}
                    {mode ? ` · ${mode === "both" ? "BB + SB dead" : "BB"}` : ""}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </section>

      {props.setupError && <p className="text-sm text-red-500">{props.setupError}</p>}
      <button
        type="button"
        onClick={props.onNext}
        disabled={Boolean(props.setupError)}
        className="w-full rounded-lg bg-accent py-3 text-sm font-medium text-white disabled:opacity-40"
      >
        Action →
      </button>
    </>
  );
}

/* --------------------------------------------------------------- board */

function BoardPrompt({
  street,
  board,
  used,
  onChange,
  onSkip,
  from,
  title,
}: {
  street: Street;
  board: string[];
  used: Set<string>;
  onChange: (b: string[]) => void;
  onSkip: () => void;
  /** Cards already on the board that stay; by default the street's own cards are picked. */
  from?: number;
  title?: string;
}) {
  const before = board.slice(0, from ?? (BOARD_SIZE[street] === 3 ? 0 : BOARD_SIZE[street] - 1));
  const need = BOARD_SIZE[street] - before.length;
  const [picks, setPicks] = useState<string[]>(board.slice(before.length, BOARD_SIZE[street]));
  const dead = new Set([...used].filter((c) => !picks.includes(c)));
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <span className="font-medium">{title ?? STREET_LABELS[street]}</span>
        <span className="text-xs text-muted">pick {need}</span>
        <span className="flex gap-0.5">
          {picks.map((c) => (
            <PlayingCard key={c} card={c} size="xs" />
          ))}
        </span>
        <button type="button" onClick={onSkip} className="ml-auto text-xs text-muted">
          Skip
        </button>
      </div>
      <CardGrid
        count={need}
        selected={picks}
        dead={dead}
        onChange={(next) => {
          setPicks(next);
          if (next.length === need) onChange([...before, ...next]);
        }}
      />
    </div>
  );
}

/** The cards an opponent showed down: pick two, or say they were not shown. */
function ShownPrompt({
  label,
  used,
  onPick,
  onMuck,
}: {
  label: string;
  used: Set<string>;
  onPick: (cards: string[]) => void;
  onMuck: () => void;
}) {
  const [picks, setPicks] = useState<string[]>([]);
  const dead = new Set([...used].filter((c) => !picks.includes(c)));
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <span className="min-w-0 truncate font-medium">{label} shows</span>
        <span className="flex gap-0.5">
          {picks.map((c) => (
            <PlayingCard key={c} card={c} size="xs" />
          ))}
        </span>
        <button type="button" onClick={onMuck} className="ml-auto shrink-0 rounded-full border border-line px-2.5 py-1 text-xs text-muted">
          Not shown
        </button>
      </div>
      <CardGrid
        count={2}
        selected={picks}
        dead={dead}
        onChange={(next) => {
          setPicks(next);
          if (next.length === 2) onPick(next);
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------- action */

function ActionPanel({
  state,
  label,
  currency,
  onAct,
}: {
  state: HandState;
  label: (seat: number) => string;
  currency: string;
  onAct: (a: HandAction) => void;
}) {
  const o = options(state)!;
  const [sizing, setSizing] = useState(false);
  const [amount, setAmount] = useState("");
  const [allIn, setAllIn] = useState(false);

  const bet = state.currentBet;
  const presets: { label: string; to: number }[] = [];
  if (o.aggressive === "bet") {
    for (const [l, f] of [["⅓", 1 / 3], ["½", 0.5], ["⅔", 2 / 3], ["¾", 0.75], ["pot", 1]] as const) {
      presets.push({ label: l, to: r2(o.pot * f) });
    }
  } else if (o.aggressive === "raise") {
    if (state.street === "preflop" && bet === state.bb) {
      for (const m of [2.5, 3, 4]) presets.push({ label: `${m} bb`, to: r2(m * state.bb) });
    } else {
      for (const m of [2.5, 3]) presets.push({ label: `${m}×`, to: r2(m * bet) });
    }
    presets.push({ label: "pot", to: potRaiseTo(state) });
  }
  const usable = presets.filter((p) => p.to >= o.minTo && (o.maxTo === null || p.to <= o.maxTo));

  const submitSize = () => {
    const to = o.maxTo !== null && allIn ? o.maxTo : parseAmount(amount);
    if (!to || Number.isNaN(to)) return;
    onAct({ seat: o.seat, kind: o.aggressive!, to, ...(allIn ? { all_in: true } : {}) });
  };

  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <p className="text-sm">
        <span className="font-semibold">{label(o.seat)}</span>
        <span className="text-muted">
          {" "}
          · {o.toCall > 0 ? `${fmtChips(o.toCall)} to call` : "nothing to call"} · pot {fmtChips(o.pot)}
          {o.behind !== null ? ` · ${fmtChips(o.behind)} behind` : ""}
        </span>
      </p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <button type="button" onClick={() => onAct({ seat: o.seat, kind: "fold" })} className="h-12 rounded-lg border border-line text-sm font-medium">
          Fold
        </button>
        {o.canCheck ? (
          <button type="button" onClick={() => onAct({ seat: o.seat, kind: "check" })} className="h-12 rounded-lg border border-line text-sm font-medium">
            Check
          </button>
        ) : (
          <button type="button" onClick={() => onAct({ seat: o.seat, kind: "call" })} className="h-12 rounded-lg border border-sky-500/50 bg-sky-500/10 text-sm font-medium">
            Call {fmtChips(o.callAmount)}
          </button>
        )}
        <button
          type="button"
          disabled={!o.aggressive}
          onClick={() => {
            setSizing((s) => !s);
            // Empty, not the minimum: typed digits must not land after a default.
            setAmount("");
          }}
          className="h-12 rounded-lg border border-rose-500/50 bg-rose-500/10 text-sm font-medium capitalize disabled:opacity-40"
        >
          {o.aggressive ?? "Raise"}…
        </button>
      </div>
      {sizing && o.aggressive && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {usable.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setAmount(fmtChips(p.to));
                  setAllIn(false);
                }}
                className="rounded-full border border-line px-2.5 py-1 text-xs"
              >
                {p.label} · {fmtChips(p.to)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted">{o.aggressive === "bet" ? "Bet" : "Raise to"}</span>
            <input
              autoFocus
              inputMode="decimal" onFocus={(e) => e.currentTarget.select()}
              value={o.maxTo !== null && allIn ? fmtChips(o.maxTo) : amount}
              placeholder={`min ${fmtChips(o.minTo)}`}
              onChange={(e) => {
                setAmount(e.target.value);
                setAllIn(false);
              }}
              onKeyDown={(e) => e.key === "Enter" && submitSize()}
              className={`${INPUT} w-28`}
            />
            <span className="text-xs text-muted">{currency}</span>
            <label className="ml-auto flex items-center gap-1 text-xs">
              <input type="checkbox" checked={allIn} onChange={(e) => setAllIn(e.target.checked)} /> all-in
            </label>
          </div>
          <p className="text-[11px] text-muted">
            Min {fmtChips(o.minTo)}
            {o.maxTo !== null ? ` · max ${fmtChips(o.maxTo)}` : ""} — the total in front of them on this street.
          </p>
          <button
            type="button"
            onClick={submitSize}
            disabled={!(o.maxTo !== null && allIn) && !amount.trim()}
            className="w-full rounded-lg bg-rose-600 py-2.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {o.aggressive === "bet" ? "Bet" : "Raise to"} {o.maxTo !== null && allIn ? fmtChips(o.maxTo) : amount || "…"}
            {allIn ? " (all-in)" : ""}
          </button>
        </div>
      )}
      {o.canCall && o.behind === null && (
        <button type="button" onClick={() => onAct({ seat: o.seat, kind: "call", all_in: true })} className="mt-2 text-xs text-muted underline">
          Calls all-in
        </button>
      )}
      <p className="mt-2 text-[11px] text-muted">Tap a later seat on the table to fold everyone before it.</p>
    </div>
  );
}

function ActionLog({
  result,
  label,
  onUndo,
}: {
  result: PlayResult;
  label: (seat: number) => string;
  onUndo?: () => void;
}) {
  if (!result.steps.length) return <p className="text-xs text-muted">Blinds are in. First action above.</p>;
  // Folds to an unraised pot are most of the log and say little: they are counted.
  const lines: { street: Street; text: (string | { folds: number })[] }[] = [];
  let opened = false;
  for (const s of result.steps) {
    let line = lines[lines.length - 1];
    if (!line || line.street !== s.street) {
      line = { street: s.street, text: [] };
      lines.push(line);
    }
    if (s.action.kind === "raise" && s.street === "preflop") opened = true;
    if (s.action.kind === "fold" && s.street === "preflop" && !opened) {
      const last = line.text[line.text.length - 1];
      if (last && typeof last === "object") last.folds++;
      else line.text.push({ folds: 1 });
    } else {
      line.text.push(`${label(s.action.seat)} ${describeStep(s)}`);
    }
  }
  return (
    <div className="rounded-lg border border-line p-3 text-xs">
      <div className="mb-1 flex items-center">
        <span className="font-medium text-muted uppercase tracking-wide">So far</span>
        {onUndo && (
          <button type="button" onClick={onUndo} className="ml-auto rounded border border-line px-2 py-1 text-xs">
            ↶ Undo
          </button>
        )}
      </div>
      {lines.map((l, i) => (
        <p key={i} className="leading-relaxed">
          <span className="font-semibold">{STREET_LABELS[l.street]}:</span>{" "}
          {l.text.map((t) => (typeof t === "string" ? t : `${t.folds} fold${t.folds > 1 ? "s" : ""}`)).join(" · ")}
        </p>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- result */

function ResultPanel(props: {
  editing: "board" | number | null;
  setEditing: (e: "board" | number | null) => void;
  state: HandState;
  settlement: ReturnType<typeof settle>;
  winners: number[][];
  setWinners: (w: number[][]) => void;
  board: string[];
  setBoard: (b: string[]) => void;
  shown: Record<number, string[]>;
  setShown: (f: (s: Record<number, string[]>) => Record<number, string[]>) => void;
  hero: number | null;
  used: Set<string>;
  label: (seat: number) => string;
  autoNet: number | null;
  netOverride: string;
  setNetOverride: (v: string) => void;
  currency: string;
  starred: boolean;
  setStarred: (v: boolean) => void;
  notes: string;
  setNotes: (v: string) => void;
}) {
  const { state, settlement, editing, setEditing } = props;
  const live = state.seats.filter((s) => !s.folded).map((s) => s.seat);
  const showdown = state.end?.reason === "showdown" || (!state.end && live.length > 1);

  const toggleWinner = (pot: number, seat: number) => {
    const next = settlement.pots.map((_, i) => [...(props.winners[i] ?? [])]);
    const cur = next[pot];
    next[pot] = cur.includes(seat) ? cur.filter((s) => s !== seat) : [...cur, seat];
    props.setWinners(next);
  };

  return (
    <>
      {!state.end && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs">The action is not finished — you can still save it as it is.</p>}

      <section>
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Board</h3>
          <span className="flex gap-0.5">
            {props.board.map((c) => (
              <PlayingCard key={c} card={c} size="xs" />
            ))}
          </span>
          <button
            type="button"
            onClick={() => setEditing(editing === "board" ? null : "board")}
            className="ml-auto rounded-full border border-line px-3 py-1 text-xs"
          >
            {editing === "board" ? "Done" : props.board.length ? "Change" : "Add the board"}
          </button>
        </div>
        {editing === "board" && (
          <div className="mt-2">
            <CardGrid
              count={5}
              selected={props.board}
              dead={new Set([...props.used].filter((c) => !props.board.includes(c)))}
              onChange={props.setBoard}
            />
          </div>
        )}
      </section>

      {showdown && (
        <section>
          <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Shown · tap a seat or “Add cards”</h3>
          <ul className="mt-1 space-y-1">
            {live
              .filter((s) => s !== props.hero)
              .map((s) => {
                const cards = props.shown[s] ?? [];
                return (
                  <li key={s}>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">{props.label(s)}</span>
                      <span className="flex gap-0.5">
                        {cards.map((c) => (
                          <PlayingCard key={c} card={c} size="xs" />
                        ))}
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditing(editing === s ? null : s)}
                        className="shrink-0 rounded-full border border-line px-3 py-1 text-xs"
                      >
                        {editing === s ? "Done" : cards.length ? "Change" : "Add cards"}
                      </button>
                    </div>
                    {editing === s && (
                      <div className="mt-1">
                        <CardGrid
                          count={2}
                          selected={cards}
                          dead={new Set([...props.used].filter((c) => !cards.includes(c)))}
                          onChange={(next) => props.setShown((x) => ({ ...x, [s]: next }))}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
          </ul>
        </section>
      )}

      <section>
        <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Pots</h3>
        {settlement.refund && (
          <p className="mt-1 text-xs text-muted">
            {fmtChips(settlement.refund.amount)} uncalled, back to {props.label(settlement.refund.seat)}.
          </p>
        )}
        <ul className="mt-1 space-y-2">
          {settlement.pots.map((p, i) => (
            <li key={i} className="rounded-lg border border-line p-2">
              <p className="text-sm font-medium">
                {i === 0 ? "Main pot" : `Side pot ${i}`} · {fmtChips(p.amount)} {props.currency}
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {p.eligible.map((s) => {
                  const on = p.takers.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      disabled={p.eligible.length === 1}
                      onClick={() => toggleWinner(i, s)}
                      className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-emerald-600 bg-emerald-600 text-white" : "border-line"}`}
                    >
                      {props.label(s)}
                    </button>
                  );
                })}
              </div>
              {p.takers.length === 0 && <p className="mt-1 text-[11px] text-muted">Who won it? Tap one, or several for a split.</p>}
            </li>
          ))}
        </ul>
      </section>

      {props.hero !== null && (
        <section className="flex items-center gap-2">
          <span className="shrink-0 text-sm">Your net</span>
          <input
            inputMode="decimal" onFocus={(e) => e.currentTarget.select()}
            value={props.netOverride}
            onChange={(e) => props.setNetOverride(e.target.value)}
            placeholder={props.autoNet !== null ? fmtChips(props.autoNet) : "?"}
            className={`${INPUT} w-28`}
          />
          <span className="text-xs text-muted">
            {props.currency} · {props.netOverride.trim() ? "set by you" : props.autoNet !== null ? "from the pots" : "pick the winners"} · before rake
          </span>
        </section>
      )}

      <section>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={props.starred} onChange={(e) => props.setStarred(e.target.checked)} /> ★ Review later
        </label>
        <textarea
          value={props.notes}
          onChange={(e) => props.setNotes(e.target.value)}
          rows={3}
          placeholder="Notes on the hand"
          className={`${INPUT} mt-2`}
        />
      </section>
    </>
  );
}
