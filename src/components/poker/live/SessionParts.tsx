"use client";

import Link from "next/link";
import { BoardCards, PlayingCard } from "@/components/poker/trainer/Cards";
import { useAction } from "@/components/jobs/controls";
import { ErrorLine } from "@/components/jobs/bits";
import { NetText, fmtClock } from "./ui";
import { positions } from "@/lib/live/hand";
import { describeMove, describeSeatEvent, readableSeatLog } from "@/lib/live/table";
import { fmtMoney, splitCards, type LiveHand, type LiveSession, type SeatEvent, type SessionEvent } from "@/lib/live/types";
import { deleteSeatEvent, deleteSessionEvent } from "@/server/actions/live";

/** One line per hand: number, time, cards, position, board, result. */
export function HandRow({ hand, sessionId, currency }: { hand: LiveHand; sessionId: string; currency: string }) {
  const cards = splitCards(hand.hero_cards);
  const pos = hand.hero_seat ? positions(hand.seats.map((s) => s.seat), hand.button_seat).get(hand.hero_seat) : null;
  return (
    <li>
      <Link href={`/poker/live/${sessionId}/hands/${hand.id}`} className="flex items-center gap-2 px-3 py-2 text-sm">
        <span className="w-8 shrink-0 text-xs tabular-nums text-muted">#{hand.number}</span>
        <span className="flex w-10 shrink-0 gap-0.5">
          {cards ? (
            <>
              <PlayingCard card={cards[0]} size="xs" />
              <PlayingCard card={cards[1]} size="xs" />
            </>
          ) : (
            <span className="text-xs text-muted">—</span>
          )}
        </span>
        <span className="w-9 shrink-0 text-[11px] font-semibold text-muted">{pos ?? ""}</span>
        <span className="min-w-0 flex-1 truncate text-xs">{hand.board.length > 0 && <BoardCards cards={hand.board} size="xs" />}</span>
        {hand.starred && <span className="text-amber-500">★</span>}
        <span className="shrink-0 text-xs">
          <NetText value={hand.hero_net} currency={currency} />
        </span>
        <span className="hidden w-10 shrink-0 text-right text-[11px] text-muted sm:inline">{fmtClock(hand.played_at)}</span>
      </Link>
    </li>
  );
}

type Line = { at: string; key: string; text: string; tone?: "money" | "break" | "hand"; del?: () => Promise<{ ok: boolean; error?: string }> };

/**
 * The session's log, newest first: who sat, left, sat out, came back; money
 * in; breaks; hands. Editable lines carry an × to take them back.
 */
export function Timeline({
  session,
  events,
  seatEvents,
  hands,
  nameOf,
  editable = false,
}: {
  session: LiveSession;
  events: SessionEvent[];
  seatEvents: SeatEvent[];
  hands: LiveHand[];
  nameOf: (playerId: string | null) => string | null;
  editable?: boolean;
}) {
  const { pending, error, run } = useAction();
  const lines: Line[] = [];
  const firstHero = seatEvents.find((e) => e.kind === "hero_move")?.id;
  // A change of seat is a leave and a sit at the same instant: one line.
  for (const { event: e, movedTo: to } of readableSeatLog(seatEvents)) {
    const text =
      e.id === firstHero
        ? `You sit in seat ${e.seat}`
        : to
          ? describeMove(e, to, nameOf(e.player_id))
          : describeSeatEvent(e, nameOf(e.player_id));
    const del = e.id === firstHero ? undefined : to ? () => deleteBoth(to.id, e.id) : () => deleteSeatEvent(e.id);
    lines.push({ at: e.at, key: e.id, text, del });
  }
  const firstBuyIn = events.find((e) => e.kind === "buy_in")?.id;
  for (const e of events) {
    const text =
      e.kind === "buy_in"
        ? `Buy-in ${fmtMoney(e.amount ?? 0, session.currency)}`
        : e.kind === "rebuy"
          ? `Rebuy ${fmtMoney(e.amount ?? 0, session.currency)}`
          : e.kind === "break_start"
            ? "Break"
            : "Back from the break";
    lines.push({
      at: e.at,
      key: e.id,
      text,
      tone: e.kind === "buy_in" || e.kind === "rebuy" ? "money" : "break",
      del: e.id === firstBuyIn ? undefined : () => deleteSessionEvent(e.id),
    });
  }
  for (const h of hands) lines.push({ at: h.played_at, key: h.id, text: `Hand #${h.number}`, tone: "hand" });
  if (session.ended_at) lines.push({ at: session.ended_at, key: "end", text: `Cash-out ${fmtMoney(session.cash_out ?? 0, session.currency)}`, tone: "money" });
  lines.sort((a, b) => b.at.localeCompare(a.at));

  // Hands make the log long and have their own list: fold runs of them.
  const folded: (Line | { key: string; hands: number; at: string })[] = [];
  for (const l of lines) {
    const last = folded[folded.length - 1];
    if (l.tone === "hand") {
      if (last && "hands" in last) last.hands++;
      else folded.push({ key: `h-${l.key}`, hands: 1, at: l.at });
    } else folded.push(l);
  }

  return (
    <section className={pending ? "opacity-70" : ""}>
      <h2 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">At the table</h2>
      <ErrorLine error={error} />
      <ul className="space-y-0.5 text-xs">
        {folded.map((l) =>
          "hands" in l ? (
            <li key={l.key} className="pl-12 text-muted">
              · {l.hands} hand{l.hands > 1 ? "s" : ""}
            </li>
          ) : (
            <li key={l.key} className="flex items-center gap-2">
              <span className="w-10 shrink-0 tabular-nums text-muted">{fmtClock(l.at)}</span>
              <span className={`min-w-0 flex-1 ${l.tone === "money" ? "font-medium" : l.tone === "break" ? "italic text-muted" : ""}`}>{l.text}</span>
              {editable && l.del && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => confirm(`Remove “${l.text}” from the log?`) && run(l.del!)}
                  className="px-1 text-muted hover:text-red-500"
                  aria-label={`Remove ${l.text}`}
                >
                  ×
                </button>
              )}
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

/** Undo a change of seat: the sit, then the leave. */
async function deleteBoth(sitId: string, leaveId: string) {
  const a = await deleteSeatEvent(sitId);
  if (!a.ok) return a;
  return deleteSeatEvent(leaveId);
}
