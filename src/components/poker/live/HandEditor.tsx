"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { CardGrid } from "./CardGrid";
import { FeltCenter, LiveTable, type BoardStreet, type SeatView } from "./LiveTable";
import { INPUT, Sheet } from "./ui";
import { PlayingCard } from "@/components/poker/trainer/Cards";
import {
  applyAction,
  behind,
  describeStep,
  foldsUntil,
  options,
  playHand,
  positions,
  settle,
  type HandState,
  type PlayResult,
} from "@/lib/live/hand";
import { bestScore, categoryName, showdownWinners } from "@/lib/live/eval";
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

/**
 * A new hand opens on the button, then Arthur's cards, then the table. An
 * existing hand opens on the table.
 */
type Step = "button" | "cards" | "play";

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Where each street's cards sit on the board, and how many. */
const STREET_SLICE: Record<BoardStreet, [number, number]> = { flop: [0, 3], turn: [3, 1], river: [4, 1] };

/** A blind bought back: the big blind live, or the big blind live and the small blind dead. */
type PostMode = "bb" | "both";

/** An opponent's cards: seen at showdown, or only what he said he had. */
type Held = { cards: string[]; how: "shown" | "said" };

function postModes(posts: HandPost[] | undefined): Record<number, PostMode> {
  return Object.fromEntries((posts ?? []).map((p) => [p.seat, p.dead > 0 ? "both" : "bb"]));
}

function heldFrom(initial: HandInput): Record<number, Held> {
  const out: Record<number, Held> = {};
  for (const [k, v] of Object.entries(initial.said ?? {})) {
    const c = splitCards(v);
    if (c) out[Number(k)] = { cards: c, how: "said" };
  }
  for (const [k, v] of Object.entries(initial.shown)) {
    const c = splitCards(v);
    if (c) out[Number(k)] = { cards: c, how: "shown" };
  }
  return out;
}

/**
 * Enter a hand on one screen that does not scroll: the table on top, one
 * panel at the bottom that asks for what comes next — the button, your cards,
 * the action of the seat to act, a street's cards, who won. A tap on a seat
 * edits it (stack, cards, dealt in or not), a tap on the board edits a street,
 * at any point. The result works itself out: from the folds, or from the
 * cards when they are known. Nothing is saved until Save.
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
  const fresh = initial.actions.length === 0 && !initial.hero_cards;
  const [step, setStep] = useState<Step>(fresh ? "button" : "play");
  const [dealt, setDealt] = useState<number[]>(initial.seats.map((s) => s.seat).sort((a, b) => a - b));
  const [button, setButton] = useState(initial.button_seat);
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
  /** Streets whose cards were not noted: not asked for again. */
  const [skipped, setSkipped] = useState<Set<Street>>(new Set());
  const [held, setHeld] = useState<Record<number, Held>>(heldFrom(initial));
  /** Winners picked by hand; null while they come from the cards. */
  const [manualWinners, setManualWinners] = useState<number[][] | null>(fresh ? null : initial.winners);
  const [netOverride, setNetOverride] = useState<string>(initial.hero_net != null && !fresh ? fmtChips(initial.hero_net) : "");
  const [starred, setStarred] = useState(initial.starred);
  const [notes, setNotes] = useState(initial.notes ?? "");
  const [seatSheet, setSeatSheet] = useState<number | null>(null);
  const [boardSheet, setBoardSheet] = useState<BoardStreet | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const hero = dealt.includes(heroSeat) ? heroSeat : initial.hero_seat && dealt.includes(initial.hero_seat) ? initial.hero_seat : null;

  /* ------------------------------------------------------------ derived */

  const nums = {
    sb: parseAmount(sb),
    bb: parseAmount(bb),
    straddle: straddle.trim() ? parseAmount(straddle) : null,
  };
  const posts: HandPost[] = dealt
    .filter((seat) => postsBy[seat])
    .map((seat) => ({ seat, live: nums.bb ?? 0, dead: postsBy[seat] === "both" ? (nums.sb ?? 0) : 0 }));
  const seats = dealt.map((seat) => {
    const st = parseAmount(stacks[seat] ?? "");
    return { seat, player_id: names.get(seat)?.playerId ?? null, stack: st && st > 0 ? st : null };
  });

  // Replayed on every render: a hand is a few dozen actions at most.
  const play = ((): { result: PlayResult; error: null } | { result: null; error: string } => {
    try {
      if (!(nums.sb! > 0) || !(nums.bb! > 0)) return { result: null, error: "Set the blinds (⋯)." };
      return {
        result: playHand({ seats, button, sb: nums.sb!, bb: nums.bb!, straddle: nums.straddle, posts }, actions),
        error: null,
      };
    } catch (e) {
      return { result: null, error: e instanceof Error ? e.message : String(e) };
    }
  })();

  const result = play.result;
  const state: HandState | null = result?.state ?? null;
  const pos = useMemo(() => positions(dealt, button), [dealt, button]);
  const label = (s: number) => seatLabel(s, pos, names, hero);
  const short = (s: number) => (s === hero ? "You" : (names.get(s)?.name ?? `Seat ${s}`));

  // Everyone's cards, for the showdown: yours, then what was shown or said.
  const cardsBySeat = new Map<number, string[]>();
  if (hero !== null && heroCards.length === 2) cardsBySeat.set(hero, heroCards);
  for (const [k, v] of Object.entries(held)) if (v.cards.length === 2 && Number(k) !== hero) cardsBySeat.set(Number(k), v.cards);

  const atShowdown = state?.end?.reason === "showdown";
  const bare = state ? settle(state, []) : null;
  const autoWinners = bare && atShowdown ? showdownWinners(bare.pots, board, cardsBySeat) : [];
  const winners = manualWinners ?? autoWinners;
  const settlement = state ? settle(state, winners) : null;
  const autoNet = settlement && hero !== null ? computedHeroNet({ settlement }, hero) : null;
  const typedNet = netOverride.trim() ? parseAmount(netOverride) : null;
  const net = typedNet !== null && !Number.isNaN(typedNet) ? typedNet : autoNet;

  const usedCards = new Set<string>([...heroCards, ...board, ...Object.values(held).flatMap((h) => h.cards)]);

  // A street just reached asks for its cards — not when an all-in runs the
  // board out: then only who won matters, the board is optional.
  const needBoard =
    step === "play" && state && !state.end && state.street !== "preflop" && board.length < BOARD_SIZE[state.street] && !skipped.has(state.street)
      ? state.street
      : null;

  /** Whose cards a seat sheet edits, and so whether a change clears the auto winners. */
  function setCards(seat: number, cards: string[], how: Held["how"] = "shown") {
    setError(null);
    setManualWinners(null);
    if (seat === hero) return setHeroCards(cards);
    setHeld((x) => {
      const next = { ...x };
      if (cards.length) next[seat] = { cards, how };
      else delete next[seat];
      return next;
    });
  }

  function setStreet(street: BoardStreet, cards: string[]) {
    setError(null);
    setManualWinners(null);
    const [at, n] = STREET_SLICE[street];
    // Clearing a street clears the ones after it: a board has no holes.
    if (cards.length === 0) return setBoard((b) => b.slice(0, at));
    setBoard((b) => [...b.slice(0, at), ...cards.slice(0, n), ...b.slice(at + n)]);
  }

  /** Apply an action if it fits; say why not otherwise. */
  function act(a: HandAction | HandAction[]) {
    if (!state) return;
    const list = Array.isArray(a) ? a : [a];
    try {
      let s = state;
      for (const x of list) s = applyAction(s, x).state;
    } catch (e) {
      return setError(e instanceof Error ? e.message : String(e));
    }
    setError(null);
    setActions((xs) => [...xs, ...list]);
  }

  function undo() {
    setError(null);
    setManualWinners(null);
    setActions((a) => a.slice(0, -1));
  }

  /* -------------------------------------------------------------- seats */

  function seatViews(): SeatView[] {
    const out: SeatView[] = [];
    for (let n = 1; n <= size; n++) {
      const nm = names.get(n);
      const isDealt = dealt.includes(n);
      const kind: SeatView["kind"] =
        n === hero || (!isDealt && n === heroSeat) ? "hero" : nm ? (nm.playerId && nm.known !== false ? "player" : "unknown") : isDealt ? "unknown" : "empty";
      const v: SeatView = { seat: n, kind, name: nm?.name ?? undefined, colors: nm?.colors, position: isDealt ? pos.get(n) : undefined };
      const h = held[n];
      if (!isDealt) {
        v.out = true;
      } else if (!state) {
        const st = parseAmount(stacks[n] ?? "");
        v.sub = st ? fmtChips(st) : undefined;
      } else {
        const s = state.seats.find((x) => x.seat === n)!;
        v.bet = s.street;
        v.out = s.folded;
        const left = behind(s);
        v.sub = postsBy[n] && actions.length === 0 ? "posts" : s.allIn ? "all-in" : s.folded ? "folded" : left !== null ? fmtChips(left) : undefined;
        if (n === hero) {
          if (heroCards.length === 2) v.cards = heroCards.join("");
          else v.addCards = true;
        } else if (h?.cards.length === 2) {
          v.cards = h.cards.join("");
          v.said = h.how === "said";
        } else v.hidden = !s.folded;
      }
      out.push(v);
    }
    return out;
  }

  function tapSeat(n: number) {
    setError(null);
    if (step === "button") {
      setButton(n);
      setStep(hero === null ? "play" : "cards");
      return;
    }
    if (step === "cards") return;
    if (!dealt.includes(n) && actions.length > 0) return;
    setSeatSheet(n);
  }

  function build(): HandInput {
    const pick = (how: Held["how"]) =>
      Object.fromEntries(
        Object.entries(held)
          .filter(([k, v]) => v.how === how && v.cards.length === 2 && Number(k) !== hero && dealt.includes(Number(k)))
          .map(([k, v]) => [k, v.cards.join("")]),
      );
    return {
      button_seat: button,
      hero_seat: hero,
      small_blind: nums.sb ?? 0,
      big_blind: nums.bb ?? 0,
      straddle: nums.straddle,
      posts,
      seats,
      actions,
      hero_cards: heroCards.length === 2 ? heroCards.join("") : null,
      board,
      shown: pick("shown"),
      said: pick("said"),
      winners: settlement ? settlement.pots.map((p) => p.takers) : [],
      hero_net: net === null || Number.isNaN(net) ? null : net,
      starred,
      notes: notes.trim() || null,
    };
  }

  function save() {
    setError(null);
    if (!result) return setError(play.error ?? "Check the hand.");
    if (!result.ok) return setError(result.error ?? "An action does not fit.");
    startSaving(async () => {
      const r = await onSave(build());
      if (!r.ok) setError(r.error ?? "Could not save.");
      else onClose();
    });
  }

  /* ------------------------------------------------------------- render */

  // At the end, what is won: an uncalled bet goes back and is not in the pot.
  const pot = state ? (state.end && settlement ? settlement.total : r2(state.pot + state.seats.reduce((t, s) => t + s.street, 0))) : null;
  const slots = state ? (atShowdown ? 5 : Math.max(BOARD_SIZE[state.street], board.length)) : 0;
  const center =
    step === "button" ? (
      <FeltCenter board={[]} note="Tap the button" />
    ) : (
      <FeltCenter
        board={board}
        slots={slots}
        onBoard={step === "play" ? (street) => setBoardSheet(street) : undefined}
        pot={pot}
        note={state && !state.end ? STREET_LABELS[state.street] : null}
      />
    );

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <button type="button" onClick={onClose} className="text-sm text-muted hover:text-foreground">
          Cancel
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-sm font-semibold">
          {title}
          {starred ? " ★" : ""}
        </div>
        <button type="button" onClick={() => setMoreOpen(true)} className="px-2 text-lg leading-none text-muted" aria-label="More">
          ⋯
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving || step !== "play"}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center px-1 py-1 [container-type:size]">
        <LiveTable
          fit
          size={size}
          seats={seatViews()}
          button={button}
          toAct={step === "play" && !needBoard ? (state?.toAct ?? null) : null}
          selected={step === "button" ? new Set([button]) : undefined}
          center={center}
          onSeat={tapSeat}
          onCards={step === "play" ? (n) => dealt.includes(n) && setSeatSheet(n) : undefined}
        />
      </div>

      <div className="shrink-0 space-y-2 border-t border-line bg-background px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {error && <p className="text-xs text-red-500">{error}</p>}

        {step === "button" ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-sm">Where is the button?</span>
            <button
              type="button"
              onClick={() => setStep(hero === null ? "play" : "cards")}
              className="h-11 rounded-lg border border-accent px-4 text-sm font-medium"
            >
              Seat {button} ✓
            </button>
          </div>
        ) : step === "cards" ? (
          <CardsPanel
            title="Your cards"
            current={heroCards}
            used={usedCards}
            onPick={(cards) => {
              setHeroCards(cards);
              setStep("play");
            }}
            onSkip={() => setStep("play")}
          />
        ) : !result ? (
          <p className="text-sm text-red-500">{play.error}</p>
        ) : !result.ok ? (
          <div className="flex items-center gap-2">
            <p className="flex-1 text-sm text-red-500">
              Action {result.failedAt! + 1}: {result.error}
            </p>
            <UndoButton onClick={undo} />
          </div>
        ) : needBoard ? (
          <CardsPanel
            key={needBoard}
            title={STREET_LABELS[needBoard]}
            count={BOARD_SIZE[needBoard] - (needBoard === "flop" ? 0 : BOARD_SIZE[needBoard] - 1)}
            current={board.slice(needBoard === "flop" ? 0 : BOARD_SIZE[needBoard] - 1, BOARD_SIZE[needBoard])}
            used={usedCards}
            onPick={(cards) => setStreet(needBoard, cards)}
            onSkip={() => setSkipped((s) => new Set(s).add(needBoard))}
            onUndo={actions.length ? undo : undefined}
          />
        ) : state && !state.end ? (
          <ActionBar
            key={actions.length}
            state={state}
            label={label}
            lastLine={lastLine(result, short)}
            preflopStart={actions.length === 0}
            straddle={nums.straddle}
            canStraddle={dealt.length >= 3}
            onStraddle={() => {
              setError(null);
              setStraddle(nums.straddle ? "" : fmtChips(r2((nums.bb ?? 0) * 2)));
            }}
            onAct={act}
            onUndo={actions.length ? undo : undefined}
          />
        ) : state && settlement ? (
          <ResultBar
            state={state}
            settlement={settlement}
            auto={manualWinners === null}
            board={board}
            cards={cardsBySeat}
            hero={hero}
            label={label}
            short={short}
            net={net}
            currency={currency}
            saving={saving}
            onToggle={(potIndex, seat) => {
              const next = settlement.pots.map((p) => [...p.takers]);
              const cur = next[potIndex];
              next[potIndex] = cur.includes(seat) ? cur.filter((s) => s !== seat) : [...cur, seat];
              setManualWinners(next);
            }}
            onCards={(seat) => setSeatSheet(seat)}
            onUndo={undo}
            onSave={save}
          />
        ) : null}
      </div>

      {seatSheet !== null && (
        <SeatSheet
          key={seatSheet}
          seat={seatSheet}
          title={dealt.includes(seatSheet) ? label(seatSheet) : `${short(seatSheet)} · seat ${seatSheet}`}
          isHero={seatSheet === hero || seatSheet === heroSeat}
          dealt={dealt.includes(seatSheet)}
          beforeAction={actions.length === 0}
          isButton={button === seatSheet}
          blind={pos.get(seatSheet) === "SB" || pos.get(seatSheet) === "BB"}
          post={postsBy[seatSheet] ?? null}
          stack={stacks[seatSheet] ?? ""}
          held={seatSheet === hero ? { cards: heroCards, how: "shown" } : (held[seatSheet] ?? { cards: [], how: "shown" })}
          used={usedCards}
          foldTo={state && !state.end && !needBoard && state.toAct !== null && state.toAct !== seatSheet ? foldsUntil(state, seatSheet) : null}
          onDeal={(on) => {
            setError(null);
            setDealt((d) => (on ? [...d, seatSheet].sort((a, b) => a - b) : d.filter((x) => x !== seatSheet)));
          }}
          onButton={() => setButton(seatSheet)}
          onPost={(m) =>
            setPostsBy((p) => {
              const next = { ...p };
              if (m) next[seatSheet] = m;
              else delete next[seatSheet];
              return next;
            })
          }
          onStack={(v) => setStacks((x) => ({ ...x, [seatSheet]: v }))}
          onCards={(cards, how) => setCards(seatSheet, cards, how)}
          onFoldTo={(folds) => {
            act(folds);
            setSeatSheet(null);
          }}
          onClose={() => setSeatSheet(null)}
        />
      )}

      {boardSheet && (
        <Sheet open onClose={() => setBoardSheet(null)} title={STREET_LABELS[boardSheet]}>
          <CardsPanel
            title={STREET_LABELS[boardSheet]}
            count={STREET_SLICE[boardSheet][1]}
            current={board.slice(STREET_SLICE[boardSheet][0], STREET_SLICE[boardSheet][0] + STREET_SLICE[boardSheet][1])}
            used={usedCards}
            onPick={(cards) => {
              setStreet(boardSheet, cards);
              setBoardSheet(null);
            }}
            clearLabel="Clear"
            onClear={() => {
              setStreet(boardSheet, []);
              setBoardSheet(null);
            }}
          />
        </Sheet>
      )}

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="Hand">
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <Amount label="SB" value={sb} onChange={setSb} />
            <Amount label="BB" value={bb} onChange={setBb} />
            <Amount label="Straddle" value={straddle} onChange={setStraddle} placeholder="—" />
          </div>
          {hero !== null && (
            <Amount
              label={`Your net (${currency}, before rake)`}
              value={netOverride}
              onChange={setNetOverride}
              placeholder={autoNet !== null ? `${fmtChips(autoNet)} — from the pots` : "?"}
            />
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={starred} onChange={(e) => setStarred(e.target.checked)} /> ★ Review later
          </label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Notes on the hand" className={INPUT} />
        </div>
      </Sheet>
    </div>
  );
}

function seatLabel(seat: number, pos: Map<number, string>, names: Map<number, SeatName>, hero: number | null): string {
  const who = seat === hero ? "You" : (names.get(seat)?.name ?? `Seat ${seat}`);
  const p = pos.get(seat);
  return p ? `${who} (${p})` : who;
}

/** The current street so far, in one line: "Marco raises to 15 · You call 15". */
function lastLine(result: PlayResult, short: (s: number) => string): string {
  const steps = result.steps.filter((s) => s.street === result.state.street && s.action.kind !== "fold");
  const folds = result.steps.filter((s) => s.street === result.state.street && s.action.kind === "fold").length;
  const parts = steps.map((s) => {
    const who = short(s.action.seat);
    const text = describeStep(s);
    // "You raise", not "You raises".
    return `${who} ${who === "You" ? text.replace(/^(\w+)s\b/, "$1") : text}`;
  });
  if (folds) parts.unshift(`${folds} fold${folds > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

function Amount({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block text-xs text-muted">
      {label}
      <input
        inputMode="decimal"
        onFocus={(e) => e.currentTarget.select()}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT}
      />
    </label>
  );
}

function UndoButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="h-9 shrink-0 rounded-lg border border-line px-3 text-sm" aria-label="Undo">
      ↶
    </button>
  );
}

/* --------------------------------------------------------------- cards */

/**
 * Pick cards from the grid; done as soon as the count is reached. The cards
 * already there come selected: tap one off, tap the new one.
 */
function CardsPanel({
  title,
  count = 2,
  current,
  used,
  onPick,
  onSkip,
  onUndo,
  clearLabel,
  onClear,
}: {
  title: string;
  count?: number;
  current: string[];
  used: Set<string>;
  onPick: (cards: string[]) => void;
  onSkip?: () => void;
  onUndo?: () => void;
  clearLabel?: string;
  onClear?: () => void;
}) {
  const [picks, setPicks] = useState<string[]>(current);
  const dead = new Set([...used].filter((c) => !picks.includes(c) && !current.includes(c)));
  return (
    <div>
      <div className="mb-1.5 flex h-7 items-center gap-2 text-sm">
        <span className="font-medium">{title}</span>
        <span className="flex gap-0.5">
          {picks.map((c) => (
            <PlayingCard key={c} card={c} size="xs" />
          ))}
        </span>
        <span className="ml-auto flex gap-2">
          {onClear && current.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setPicks([]);
                onClear();
              }}
              className="text-xs text-muted"
            >
              {clearLabel ?? "Clear"}
            </button>
          )}
          {onSkip && (
            <button type="button" onClick={onSkip} className="rounded-full border border-line px-3 py-1 text-xs text-muted">
              Skip
            </button>
          )}
          {onUndo && (
            <button type="button" onClick={onUndo} className="rounded-full border border-line px-2.5 py-1 text-xs" aria-label="Undo">
              ↶
            </button>
          )}
        </span>
      </div>
      <CardGrid
        count={count}
        selected={picks}
        dead={dead}
        onChange={(next) => {
          setPicks(next);
          if (next.length === count) onPick(next);
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------- action */

/**
 * The seat to act: check or fold, call, all-in in one tap; a raise is the
 * amount typed, then one tap (or Enter). Bet or raise is worked out.
 */
function ActionBar({
  state,
  label,
  lastLine,
  preflopStart,
  straddle,
  canStraddle,
  onStraddle,
  onAct,
  onUndo,
}: {
  state: HandState;
  label: (seat: number) => string;
  lastLine: string;
  preflopStart: boolean;
  straddle: number | null;
  canStraddle: boolean;
  onStraddle: () => void;
  onAct: (a: HandAction) => void;
  onUndo?: () => void;
}) {
  const o = options(state)!;
  const [amount, setAmount] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const shoveTo = o.maxTo;

  const raise = (allIn = false) => {
    const typed = parseAmount(amount);
    if (!o.aggressive) return;
    if (allIn && shoveTo !== null) return onAct({ seat: o.seat, kind: o.aggressive, to: shoveTo, all_in: true });
    if (!typed || Number.isNaN(typed)) return input.current?.focus();
    const to = shoveTo !== null && typed >= shoveTo ? shoveTo : typed;
    onAct({ seat: o.seat, kind: o.aggressive, to, ...(allIn || to === shoveTo ? { all_in: true } : {}) });
  };

  const allIn = () => {
    // Known stack: shove it, or call it off when a raise is not possible.
    if (o.behind !== null) {
      if (o.aggressive && shoveTo !== null && shoveTo > state.currentBet) return raise(true);
      return onAct({ seat: o.seat, kind: "call" });
    }
    // Unknown stack: the amount typed is the shove; with none, an all-in call.
    if (amount.trim() && o.aggressive) return raise(true);
    if (o.canCall) return onAct({ seat: o.seat, kind: "call", all_in: true });
    input.current?.focus();
  };

  return (
    <div className="space-y-2">
      <div className="flex h-6 items-center gap-2 text-sm">
        <span className="shrink-0 font-semibold">{label(o.seat)}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {lastLine || (o.behind !== null ? `${fmtChips(o.behind)} behind` : "")}
        </span>
        {preflopStart && canStraddle && (
          <button
            type="button"
            onClick={onStraddle}
            aria-pressed={straddle !== null}
            className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs ${straddle !== null ? "border-accent bg-accent text-white" : "border-line"}`}
          >
            Straddle{straddle !== null ? ` ${fmtChips(straddle)}` : ""}
          </button>
        )}
        {onUndo && (
          <button type="button" onClick={onUndo} className="shrink-0 rounded-full border border-line px-2.5 py-0.5 text-xs" aria-label="Undo">
            ↶
          </button>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => onAct({ seat: o.seat, kind: o.canCheck ? "check" : "fold" })}
          className="h-12 rounded-lg border border-line text-sm font-medium"
        >
          {o.canCheck ? "Check" : "Fold"}
        </button>
        <button
          type="button"
          disabled={!o.canCall}
          onClick={() => onAct({ seat: o.seat, kind: "call" })}
          className="h-12 rounded-lg border border-sky-500/50 bg-sky-500/10 text-sm font-medium disabled:opacity-30"
        >
          Call{o.canCall ? ` ${fmtChips(o.callAmount)}` : ""}
        </button>
        <button type="button" onClick={allIn} className="h-12 rounded-lg border border-rose-500/60 bg-rose-500/15 text-sm font-semibold">
          All-in{shoveTo !== null && o.aggressive ? ` ${fmtChips(shoveTo)}` : ""}
        </button>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          raise();
        }}
      >
        <input
          ref={input}
          inputMode="decimal"
          enterKeyHint="go"
          value={amount}
          disabled={!o.aggressive}
          placeholder={o.aggressive ? `${o.aggressive === "bet" ? "Bet" : "Raise to"} · min ${fmtChips(o.minTo)}` : "No raise possible"}
          onChange={(e) => setAmount(e.target.value)}
          className={`${INPUT} mt-0 h-11 flex-1`}
        />
        <button
          type="submit"
          disabled={!o.aggressive || !amount.trim()}
          className="h-11 w-24 rounded-lg bg-rose-600 text-sm font-medium text-white capitalize disabled:opacity-40"
        >
          {o.aggressive ?? "raise"}
        </button>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------- result */

/**
 * The end of the hand. Won without showdown: nothing to do but save. At a
 * showdown the winners come from the cards when they are all known; until
 * then, or to change them, tap who took each pot. An all-in before the river
 * needs no board: only who won.
 */
function ResultBar({
  state,
  settlement,
  auto,
  board,
  cards,
  hero,
  label,
  short,
  net,
  currency,
  saving,
  onToggle,
  onCards,
  onUndo,
  onSave,
}: {
  state: HandState;
  settlement: ReturnType<typeof settle>;
  auto: boolean;
  board: string[];
  cards: Map<number, string[]>;
  hero: number | null;
  label: (seat: number) => string;
  short: (seat: number) => string;
  net: number | null;
  currency: string;
  saving: boolean;
  onToggle: (pot: number, seat: number) => void;
  onCards: (seat: number) => void;
  onUndo: () => void;
  onSave: () => void;
}) {
  const end = state.end!;
  const live = state.seats.filter((s) => !s.folded).map((s) => s.seat);
  const handName = (s: number) => {
    const c = cards.get(s);
    return c && board.length === 5 ? categoryName(bestScore([...c, ...board])) : null;
  };
  const missing = end.reason === "showdown" ? live.filter((s) => !cards.has(s)) : [];
  const open = settlement.pots.some((p) => p.takers.length === 0);

  return (
    <div className="space-y-2">
      <div className="flex h-6 items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">
          {end.reason === "fold" ? `${label(end.winner)} wins ${fmtChips(settlement.total)}` : end.runout ? "All-in — who wins?" : "Showdown"}
        </span>
        <UndoButton onClick={onUndo} />
      </div>

      {end.reason === "showdown" && (
        <>
          <ul className="max-h-36 space-y-1.5 overflow-y-auto">
            {settlement.pots.map((p, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <span className="w-16 shrink-0 text-xs text-muted">
                  {settlement.pots.length === 1 ? "Pot" : i === 0 ? "Main" : `Side ${i}`} {fmtChips(p.amount)}
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {p.eligible.map((s) => {
                    const on = p.takers.includes(s);
                    const hn = handName(s);
                    return (
                      <button
                        key={s}
                        type="button"
                        disabled={p.eligible.length === 1}
                        onClick={() => onToggle(i, s)}
                        className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-emerald-600 bg-emerald-600 text-white" : "border-line"}`}
                      >
                        {short(s)}
                        {hn ? ` · ${hn}` : ""}
                      </button>
                    );
                  })}
                </span>
              </li>
            ))}
          </ul>
          {missing.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted">Cards:</span>
              {missing.map((s) => (
                <button key={s} type="button" onClick={() => onCards(s)} className="rounded-full border border-dashed border-line px-2.5 py-1">
                  {short(s)} +
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <div className="flex items-center gap-3">
        <span className="flex-1 text-sm">
          {hero !== null && net !== null ? (
            <>
              Net{" "}
              <span className={`font-semibold tabular-nums ${net > 0 ? "text-emerald-600" : net < 0 ? "text-red-500" : ""}`}>
                {net > 0 ? "+" : net < 0 ? "−" : ""}
                {fmtChips(Math.abs(net))} {currency}
              </span>
              {end.reason === "showdown" && !open && auto && <span className="text-xs text-muted"> · from the cards</span>}
            </>
          ) : open ? (
            <span className="text-xs text-muted">Tap who won</span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="h-11 rounded-lg bg-accent px-6 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- seat */

/**
 * One seat, at any point of the hand: its cards (shown or only said, for an
 * opponent) and its stack; before the first action also whether it is dealt
 * in, the button, and blinds bought back. During the action, "Fold to here"
 * folds everyone who acts before it.
 */
function SeatSheet(props: {
  seat: number;
  title: string;
  isHero: boolean;
  dealt: boolean;
  beforeAction: boolean;
  isButton: boolean;
  blind: boolean;
  post: PostMode | null;
  stack: string;
  held: Held;
  used: Set<string>;
  foldTo: HandAction[] | null;
  onDeal: (on: boolean) => void;
  onButton: () => void;
  onPost: (m: PostMode | null) => void;
  onStack: (v: string) => void;
  onCards: (cards: string[], how: Held["how"]) => void;
  onFoldTo: (folds: HandAction[]) => void;
  onClose: () => void;
}) {
  const [how, setHow] = useState<Held["how"]>(props.held.how);
  const chip = (on: boolean) => `rounded-full border px-3 py-1.5 text-xs ${on ? "border-accent bg-accent text-white" : "border-line"}`;
  return (
    <Sheet open onClose={props.onClose} title={props.title}>
      <div className="space-y-3">
        {props.beforeAction && (
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => props.onDeal(!props.dealt)} className={chip(props.dealt)}>
              {props.dealt ? "Dealt in" : "Out"}
            </button>
            <button type="button" onClick={props.onButton} className={chip(props.isButton)}>
              Button
            </button>
            {props.dealt && !props.blind && (
              <>
                <button type="button" onClick={() => props.onPost(props.post === "bb" ? null : "bb")} className={chip(props.post === "bb")}>
                  Posts BB
                </button>
                <button type="button" onClick={() => props.onPost(props.post === "both" ? null : "both")} className={chip(props.post === "both")}>
                  Posts BB + SB dead
                </button>
              </>
            )}
          </div>
        )}

        {props.dealt && (
          <>
            <div className="flex items-end gap-2">
              <label className="flex-1 text-xs text-muted">
                Stack
                <input
                  inputMode="decimal"
                  onFocus={(e) => e.currentTarget.select()}
                  value={props.stack}
                  placeholder="?"
                  onChange={(e) => props.onStack(e.target.value)}
                  className={INPUT}
                />
              </label>
              {props.foldTo && (
                <button type="button" onClick={() => props.onFoldTo(props.foldTo!)} className="h-10 rounded-lg border border-line px-3 text-sm">
                  Fold to here
                </button>
              )}
            </div>

            {!props.isHero && (
              <div className="flex gap-1.5">
                {(["shown", "said"] as const).map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => {
                      setHow(h);
                      if (props.held.cards.length === 2) props.onCards(props.held.cards, h);
                    }}
                    className={chip(how === h)}
                  >
                    {h === "shown" ? "Shown" : "Said he had"}
                  </button>
                ))}
              </div>
            )}
            <CardsPanel
              title={props.isHero ? "Your cards" : how === "shown" ? "Shows" : "Says he had"}
              current={props.held.cards}
              used={props.used}
              onPick={(cards) => {
                props.onCards(cards, how);
                props.onClose();
              }}
              onClear={() => props.onCards([], how)}
            />
          </>
        )}
      </div>
    </Sheet>
  );
}
