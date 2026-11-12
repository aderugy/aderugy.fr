"use client";

import Link from "next/link";
import { useState } from "react";
import { BoardCards, PlayingCard } from "@/components/poker/trainer/Cards";
import { useAction } from "@/components/jobs/controls";
import { ErrorLine } from "@/components/jobs/bits";
import { INPUT, NetText, fmtClock } from "./ui";
import { positions } from "@/lib/live/hand";
import {
  describeMove,
  describeSeatEvent,
  readableSeatLog,
} from "@/lib/live/table";
import {
  fmtMoney,
  splitCards,
  type LiveHand,
  type LiveSession,
  type SeatEvent,
  type SessionEvent,
} from "@/lib/live/types";
import {
  addExpense,
  deleteSeatEvent,
  deleteSessionEvent,
} from "@/server/actions/live";

/** One line per hand: number, time, cards, position, board, result. */
export function HandRow({
  hand,
  sessionId,
  currency,
}: {
  hand: LiveHand;
  sessionId: string;
  currency: string;
}) {
  const cards = splitCards(hand.hero_cards);
  const pos = hand.hero_seat
    ? positions(
        hand.seats.map((s) => s.seat),
        hand.button_seat,
      ).get(hand.hero_seat)
    : null;
  return (
    <li>
      <Link
        href={`/poker/live/${sessionId}/hands/${hand.id}`}
        className="flex items-center gap-2 px-3 py-2 text-sm"
      >
        <span className="w-8 shrink-0 text-xs tabular-nums text-muted">
          #{hand.number}
        </span>
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
        <span className="w-9 shrink-0 text-[11px] font-semibold text-muted">
          {pos ?? ""}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs">
          {hand.board.length > 0 && <BoardCards cards={hand.board} size="xs" />}
        </span>
        {hand.starred && <span className="text-amber-500">★</span>}
        <span className="shrink-0 text-xs">
          <NetText value={hand.hero_net} currency={currency} />
        </span>
        <span className="hidden w-10 shrink-0 text-right text-[11px] text-muted sm:inline">
          {fmtClock(hand.played_at)}
        </span>
      </Link>
    </li>
  );
}

type Line = {
  at: string;
  key: string;
  text: string;
  tone?: "money" | "break" | "hand";
  del?: () => Promise<{ ok: boolean; error?: string }>;
};

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
    const del =
      e.id === firstHero
        ? undefined
        : to
          ? () => deleteBoth(to.id, e.id)
          : () => deleteSeatEvent(e.id);
    lines.push({ at: e.at, key: e.id, text, del });
  }
  const firstBuyIn = events.find((e) => e.kind === "buy_in")?.id;
  for (const e of events) {
    const text =
      e.kind === "buy_in"
        ? `Buy-in ${fmtMoney(e.amount ?? 0, session.currency)}`
        : e.kind === "rebuy"
          ? `Rebuy ${fmtMoney(e.amount ?? 0, session.currency)}`
          : e.kind === "expense"
            ? `${e.label ?? "Food & drinks"} ${fmtMoney(e.amount ?? 0, session.currency)}`
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
  for (const h of hands)
    lines.push({
      at: h.played_at,
      key: h.id,
      text: `Hand #${h.number}`,
      tone: "hand",
    });
  if (session.ended_at)
    lines.push({
      at: session.ended_at,
      key: "end",
      text: `Cash-out ${fmtMoney(session.cash_out ?? 0, session.currency)}`,
      tone: "money",
    });
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
      <h2 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">
        At the table
      </h2>
      <ErrorLine error={error} />
      <ul className="space-y-0.5 text-xs">
        {folded.map((l) =>
          "hands" in l ? (
            <li key={l.key} className="pl-12 text-muted">
              · {l.hands} hand{l.hands > 1 ? "s" : ""}
            </li>
          ) : (
            <li key={l.key} className="flex items-center gap-2">
              <span className="w-10 shrink-0 tabular-nums text-muted">
                {fmtClock(l.at)}
              </span>
              <span
                className={`min-w-0 flex-1 ${l.tone === "money" ? "font-medium" : l.tone === "break" ? "italic text-muted" : ""}`}
              >
                {l.text}
              </span>
              {editable && l.del && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    confirm(`Remove “${l.text}” from the log?`) && run(l.del!)
                  }
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

/**
 * Food and drinks bought at the table. Not poker money: the result stays
 * cash-out − buy-ins, and this shows what is left after them.
 */
export function Expenses({
  session,
  events,
  net,
}: {
  session: LiveSession;
  events: SessionEvent[];
  net: number | null;
}) {
  const { pending, error, run } = useAction();
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const list = events
    .filter((e) => e.kind === "expense")
    .sort((a, b) => a.at.localeCompare(b.at));
  const total =
    Math.round(list.reduce((t, e) => t + (e.amount ?? 0), 0) * 100) / 100;

  return (
    <section className={pending ? "opacity-70" : ""}>
      <h2 className="mb-1 flex items-baseline gap-2 text-xs font-medium tracking-wide text-muted uppercase">
        Food & drinks
        {total > 0 ? ` · ${fmtMoney(total, session.currency)}` : ""}
        {total > 0 && net !== null && (
          <span className="ml-auto normal-case tracking-normal">
            result after:{" "}
            <NetText
              value={Math.round((net - total) * 100) / 100}
              currency={session.currency}
            />
          </span>
        )}
      </h2>
      {list.length > 0 && (
        <ul className="mb-2 divide-y divide-line rounded-lg border border-line bg-surface text-sm">
          {list.map((e) => (
            <li key={e.id} className="flex items-center gap-2 px-3 py-1.5">
              <span className="w-10 shrink-0 text-xs tabular-nums text-muted">
                {fmtClock(e.at)}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {e.label ?? "Food & drinks"}
              </span>
              <span className="tabular-nums">
                {fmtMoney(e.amount ?? 0, session.currency)}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  confirm(`Remove “${e.label ?? "Food & drinks"}”?`) &&
                  run(() => deleteSessionEvent(e.id))
                }
                className="px-1 text-muted hover:text-red-500"
                aria-label={`Remove ${e.label ?? "expense"}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          run(
            () => addExpense(session.id, { label: label || null, amount }),
            () => {
              setLabel("");
              setAmount("");
            },
          );
        }}
        className="flex gap-2"
      >
        <div className="min-w-0 flex-1">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Rice, coffee…"
            className={INPUT}
          />
        </div>
        <div className="w-20 shrink-0">
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={session.currency}
            className={INPUT}
          />
        </div>
        <button
          type="submit"
          disabled={pending || !amount}
          className="rounded-lg border border-line px-3 text-sm disabled:opacity-50"
        >
          Add
        </button>
      </form>
      <ErrorLine error={error} />
    </section>
  );
}
