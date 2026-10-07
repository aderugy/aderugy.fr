"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { HandEditor, type SeatName } from "./HandEditor";
import { FeltCenter, LiveTable, type SeatView } from "./LiveTable";
import { PlayerNotes } from "./PlayerNotes";
import { NetText, fmtClock, fmtDay } from "./ui";
import { useAction } from "@/components/jobs/controls";
import { ErrorLine } from "@/components/jobs/bits";
import { NotesEditor } from "@/components/ui/NotesEditor";
import { DEFAULT_COLOR } from "@/lib/categories";
import { behind, describeStep, playHand, positions, settle, stepsByStreet, type HandState, type Step } from "@/lib/live/hand";
import { BOARD_SIZE, STREET_LABELS, fmtChips, type LiveHand, type Street } from "@/lib/live/types";
import type { SessionBundle } from "@/server/live/data";
import { deleteHand, updateHand, updateHandFlags } from "@/server/actions/live";

/**
 * One hand: replayed on the table step by step, written out street by street,
 * with who took the pots and what Arthur made. Edit reopens the editor.
 */
export function HandView({ data, hand }: { data: SessionBundle; hand: LiveHand }) {
  const { session, hands, players, tags, notes } = data;
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [noteFor, setNoteFor] = useState<string | null>(null);

  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
  const names = useMemo(() => {
    const m = new Map<number, SeatName>();
    for (const s of hand.seats) {
      const p = s.player_id ? playerById.get(s.player_id) : null;
      m.set(s.seat, {
        playerId: s.player_id,
        name: p?.name ?? null,
        colors: p ? p.tag_ids.map((id) => tagById.get(id)?.color ?? DEFAULT_COLOR) : [],
      });
    }
    return m;
  }, [hand.seats, playerById, tagById]);

  const play = useMemo(() => {
    try {
      return playHand(
        { seats: hand.seats, button: hand.button_seat, sb: hand.small_blind, bb: hand.big_blind, straddle: hand.straddle },
        hand.actions,
      );
    } catch {
      return null;
    }
  }, [hand]);
  const total = play ? play.steps.length : 0;
  const [rawStep, setStep] = useState(total);
  // After an edit the hand may have fewer steps than where the replay stood.
  const step = Math.min(rawStep, total);

  const pos = positions(
    hand.seats.map((s) => s.seat),
    hand.button_seat,
  );
  const label = (seat: number) => {
    const who = seat === hand.hero_seat ? "You" : (names.get(seat)?.name ?? `Seat ${seat}`);
    return `${who} (${pos.get(seat) ?? seat})`;
  };

  const i = hands.findIndex((h) => h.id === hand.id);
  const prev = hands[i - 1];
  const next = hands[i + 1];

  if (!play) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm">
        <p>This hand cannot be replayed (its setup is broken). Edit it to fix it.</p>
      </main>
    );
  }

  const state: HandState = step === 0 ? play.start : play.steps[step - 1].state;
  const last = step > 0 ? play.steps[step - 1] : null;
  const atEnd = step === total;
  const boardShown = atEnd && state.end?.reason === "showdown" ? hand.board : hand.board.slice(0, BOARD_SIZE[state.street]);
  const settlement = settle(play.state, hand.winners);

  const views: SeatView[] = hand.seats.map((s) => {
    const st = state.seats.find((x) => x.seat === s.seat)!;
    const nm = names.get(s.seat);
    const isHero = s.seat === hand.hero_seat;
    const shownCards = atEnd ? hand.shown[String(s.seat)] : null;
    const left = behind(st);
    return {
      seat: s.seat,
      kind: isHero ? "hero" : nm?.playerId ? "player" : "unknown",
      name: nm?.name ?? undefined,
      colors: nm?.colors,
      position: pos.get(s.seat),
      bet: st.street,
      out: st.folded,
      cards: isHero ? hand.hero_cards : shownCards,
      hidden: !isHero && !shownCards && !st.folded,
      sub:
        last && last.action.seat === s.seat
          ? describeStep(last)
          : st.allIn
            ? "all-in"
            : left !== null
              ? fmtChips(left)
              : undefined,
    };
  });

  const playersInHand = hand.seats.filter((s) => s.player_id && s.seat !== hand.hero_seat);

  return (
    <main className={`mx-auto h-full w-full max-w-2xl overflow-y-auto px-3 py-4 sm:px-6 ${pending ? "opacity-80" : ""}`}>
      <div className="flex items-center gap-2 text-xs text-muted">
        <Link href={`/poker/live/${session.id}`} className="hover:text-foreground">
          ← {session.venue}
        </Link>
        <span className="ml-auto flex gap-3">
          {prev ? <Link href={`/poker/live/${session.id}/hands/${prev.id}`}>‹ #{prev.number}</Link> : <span className="opacity-30">‹</span>}
          {next ? <Link href={`/poker/live/${session.id}/hands/${next.id}`}>#{next.number} ›</Link> : <span className="opacity-30">›</span>}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <h1 className="text-lg font-semibold tracking-tight">Hand #{hand.number}</h1>
        <button
          type="button"
          onClick={() => run(() => updateHandFlags(hand.id, { starred: !hand.starred }))}
          className={`text-lg ${hand.starred ? "text-amber-500" : "text-muted"}`}
          aria-label={hand.starred ? "Unstar" : "Star for review"}
        >
          ★
        </button>
        <span className="text-xs text-muted">
          {fmtDay(hand.played_at)} · {fmtClock(hand.played_at)} · {fmtChips(hand.small_blind)}/{fmtChips(hand.big_blind)}
          {hand.straddle ? ` · straddle ${fmtChips(hand.straddle)}` : ""}
        </span>
        <span className="ml-auto text-base font-semibold">
          <NetText value={hand.hero_net} currency={session.currency} />
        </span>
      </div>
      <ErrorLine error={error} />

      <div className="mt-2">
        <LiveTable
          size={session.seats}
          seats={views}
          button={hand.button_seat}
          toAct={atEnd ? null : state.toAct}
          center={
            <FeltCenter
              board={boardShown}
              pot={state.pot + state.seats.reduce((t, s) => t + s.street, 0)}
              note={state.end && atEnd ? (state.end.reason === "fold" ? `${label(state.end.winner)} wins` : "Showdown") : STREET_LABELS[state.street]}
            />
          }
        />
      </div>

      {total > 0 && (
        <div className="mt-1 flex items-center gap-2">
          <button type="button" onClick={() => setStep(0)} className="h-10 w-10 rounded-lg border border-line" aria-label="Start">
            ⏮
          </button>
          <button type="button" onClick={() => setStep(Math.max(0, step - 1))} className="h-10 flex-1 rounded-lg border border-line" aria-label="Back">
            ◀
          </button>
          <span className="w-16 text-center text-xs tabular-nums text-muted">
            {step}/{total}
          </span>
          <button type="button" onClick={() => setStep(Math.min(total, step + 1))} className="h-10 flex-1 rounded-lg border border-line" aria-label="Forward">
            ▶
          </button>
          <button type="button" onClick={() => setStep(total)} className="h-10 w-10 rounded-lg border border-line" aria-label="End">
            ⏭
          </button>
        </div>
      )}

      <section className="mt-4 rounded-lg border border-line bg-surface p-3 text-sm">
        {play.steps.length === 0 ? (
          <p className="text-xs text-muted">No action entered.</p>
        ) : (
          stepsByStreet(play.steps).map((g) => (
            <p key={g.street} className="leading-relaxed">
              <span className="font-semibold">{STREET_LABELS[g.street]}</span>
              {g.street !== "preflop" && hand.board.length >= BOARD_SIZE[g.street] && (
                <span className="text-muted"> [{hand.board.slice(0, BOARD_SIZE[g.street]).join(" ")}]</span>
              )}
              :{" "}
              {preflopLine(g.steps, g.street, label)}
            </p>
          ))
        )}
        {settlement.pots.length > 0 && (
          <p className="mt-2 border-t border-line pt-2 text-xs text-muted">
            {settlement.pots
              .map(
                (p, k) =>
                  `${k === 0 ? "Pot" : `Side pot ${k}`} ${fmtChips(p.amount)} → ${p.takers.length ? p.takers.map(label).join(" & ") : "?"}`,
              )
              .join(" · ")}
            {Object.keys(hand.shown).length > 0 &&
              ` · shown: ${Object.entries(hand.shown)
                .map(([s, c]) => `${label(Number(s))} ${c}`)
                .join(", ")}`}
          </p>
        )}
      </section>

      <section className="mt-4">
        <h2 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Notes on the hand</h2>
        <NotesEditor value={hand.notes} onSave={(v) => run(() => updateHandFlags(hand.id, { notes: v }))} startClosed addLabel="Add notes" />
      </section>

      {playersInHand.length > 0 && (
        <section className="mt-4">
          <h2 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">A note on a player, from this hand</h2>
          <div className="flex flex-wrap gap-1.5">
            {playersInHand.map((s) => (
              <button
                key={s.seat}
                type="button"
                onClick={() => setNoteFor(noteFor === s.player_id ? null : s.player_id)}
                className={`rounded-full border px-2.5 py-1 text-xs ${noteFor === s.player_id ? "border-accent bg-accent text-white" : "border-line"}`}
              >
                {label(s.seat)}
              </button>
            ))}
          </div>
          {noteFor && (
            <div className="mt-2">
              <PlayerNotes
                key={noteFor}
                playerId={noteFor}
                notes={notes.filter((n) => n.player_id === noteFor)}
                sessionId={session.id}
                handId={hand.id}
                limit={3}
              />
            </div>
          )}
        </section>
      )}

      <div className="mt-6 flex gap-2">
        <button type="button" onClick={() => setEditing(true)} className="flex-1 rounded-lg border border-line py-2.5 text-sm font-medium">
          Edit the hand
        </button>
        <button
          type="button"
          onClick={() => confirm(`Delete hand #${hand.number}?`) && run(() => deleteHand(hand.id), () => router.push(`/poker/live/${session.id}`))}
          className="rounded-lg border border-red-500/40 px-4 py-2.5 text-sm text-red-600 dark:text-red-400"
        >
          Delete
        </button>
      </div>

      {editing && (
        <HandEditor
          title={`Hand #${hand.number}`}
          size={session.seats}
          currency={session.currency}
          heroSeat={hand.hero_seat ?? session.hero_seat}
          names={names}
          initial={{ ...hand }}
          onSave={(input) => updateHand(hand.id, input)}
          onClose={() => setEditing(false)}
        />
      )}
    </main>
  );
}

/** A street's actions in words; folds to an unraised pot preflop are only counted. */
function preflopLine(steps: Step[], street: Street, label: (seat: number) => string): string {
  const out: string[] = [];
  let opened = street !== "preflop";
  let folds = 0;
  const flush = () => {
    if (folds) out.push(`${folds} fold${folds > 1 ? "s" : ""}`);
    folds = 0;
  };
  for (const s of steps) {
    if (s.action.kind === "fold" && !opened) {
      folds++;
      continue;
    }
    flush();
    if (s.action.kind === "raise") opened = true;
    out.push(`${label(s.action.seat)} ${describeStep(s)}`);
  }
  flush();
  return out.join(" · ");
}
