"use client";

import type { CSSProperties, ReactNode } from "react";
import { PlayingCard, CardBack } from "@/components/poker/trainer/Cards";
import { splitCards } from "@/lib/live/types";

/**
 * A full-ring casino table seen from above: the dealer in the middle of the
 * left side, seat 1 on the dealer's left (just above them), numbers
 * increasing clockwise along the top, down the right side, along the bottom
 * and back up to the dealer — which is also the order action goes in. A
 * taller oval on phones, wider from `sm` up. With `fit`, the table takes the
 * largest size that fits its container (which must have a definite height).
 */

export type SeatView = {
  seat: number;
  /** "unknown": someone not identified — a named unknown player, or nobody on file. */
  kind: "hero" | "player" | "unknown" | "empty";
  name?: string;
  /** Tag colours, shown as dots. */
  colors?: string[];
  sittingOut?: boolean;
  /** In a hand: dimmed when not dealt in or folded. */
  out?: boolean;
  /** A short line under the name: stack, "all-in", "sitting out"… */
  sub?: string;
  position?: string;
  /** Chips in front of the seat on this street. */
  bet?: number;
  /** Face-up cards (shown at showdown, or the hero's). */
  cards?: string | null;
  /** The face-up cards were only said, not shown: drawn faded, marked "said". */
  said?: boolean;
  /** Face-down cards in front of a seat still in the hand. */
  hidden?: boolean;
  /** No cards yet, but they can be added: an empty slot to tap. */
  addCards?: boolean;
};

const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0$/, ""));

/** Where seat `seat` of `size` sits, as percentages of the table box. */
function anchor(seat: number, size: number, k = 1): { x: number; y: number } {
  // The dealer is at angle 0, on the left; seats follow clockwise.
  const theta = (seat * 2 * Math.PI) / (size + 1) - Math.PI / 2;
  return { x: 50 + 41 * k * Math.sin(theta), y: 50 - 41 * k * Math.cos(theta) };
}

function at(p: { x: number; y: number }): CSSProperties {
  // Rounded: the server and the browser need not agree on the last digits of a sine.
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { left: `${r(p.x)}%`, top: `${r(p.y)}%` };
}

export function LiveTable({
  size,
  seats,
  button = null,
  toAct = null,
  center,
  onSeat,
  selected,
  label,
  onCards,
  fit = false,
  money = fmt,
}: {
  /** How amounts are written (chips by default). */
  money?: (x: number) => string;
  /** Fill the container's height and width, keeping the table's shape. */
  fit?: boolean;
  size: number;
  seats: SeatView[];
  /** Tapping a seat's cards (or its empty card slot) — distinct from tapping the seat. */
  onCards?: (seat: number) => void;
  button?: number | null;
  toAct?: number | null;
  center?: ReactNode;
  onSeat?: (seat: number) => void;
  /** Seats drawn with a ring (picked in a setup step). */
  selected?: Set<number>;
  /** Text on the felt when nothing else is there. */
  label?: string;
}) {
  const bySeat = new Map(seats.map((s) => [s.seat, s]));
  const all = Array.from({ length: size }, (_, i) => i + 1);

  return (
    <div
      className={
        fit
          ? "relative mx-auto aspect-[3/4] w-[min(100cqw,75cqh)] select-none sm:aspect-[16/10] sm:w-[min(100cqw,160cqh)]"
          : "relative mx-auto aspect-[3/4] w-full max-w-[26rem] select-none sm:aspect-[16/10] sm:max-w-2xl"
      }
    >
      {/* Felt */}
      <div
        className="absolute inset-[11%] rounded-[50%] border-[5px] border-[#5b3a1e] shadow-inner"
        style={{ background: "radial-gradient(ellipse at center, #2f7d4f 0%, #1f5c3a 70%, #184a2f 100%)" }}
      />
      {/* The dealer's place */}
      <div className="absolute left-[11%] top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white/80">
        Dealer
      </div>

      <div className="absolute left-1/2 top-1/2 flex w-[60%] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5 text-center">
        {center ?? (label ? <span className="text-xs text-white/70">{label}</span> : null)}
      </div>

      {all.map((n) => {
        const s = bySeat.get(n) ?? { seat: n, kind: "empty" as const };
        const p = anchor(n, size);
        const bet = s.bet ?? 0;
        const cards = splitCards(s.cards ?? null);
        const isSel = selected?.has(n);
        const dim = s.out || (s.kind !== "empty" && s.sittingOut);
        return (
          <div key={n}>
            {bet > 0 && (
              <div className="absolute z-10 -translate-x-1/2 -translate-y-1/2" style={at(anchor(n, size, 0.58))}>
                <span className="flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">
                  <span className="inline-block size-2 rounded-full border border-white/70 bg-amber-400" />
                  {money(bet)}
                </span>
              </div>
            )}
            {button === n && (
              <span
                className="absolute z-10 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-black/20 bg-white text-[10px] font-bold text-black shadow"
                style={at(anchor(n + 0.42, size, 0.74))}
                aria-label="Button"
              >
                D
              </span>
            )}
            <button
              type="button"
              onClick={onSeat ? () => onSeat(n) : undefined}
              disabled={!onSeat}
              className="absolute z-20 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center disabled:cursor-default"
              style={at(p)}
              aria-label={`Seat ${n}${s.name ? `, ${s.name}` : s.kind === "empty" ? ", empty" : ""}`}
            >
              {(cards || s.hidden || (s.addCards && onCards)) && (
                <span
                  role={onCards ? "button" : undefined}
                  tabIndex={onCards ? 0 : undefined}
                  aria-label={onCards ? `Cards of seat ${n}` : undefined}
                  onClick={
                    onCards
                      ? (e) => {
                          e.stopPropagation();
                          onCards(n);
                        }
                      : undefined
                  }
                  className={`relative mb-0.5 flex gap-0.5 ${onCards ? "-m-1.5 cursor-pointer p-1.5" : ""} ${s.out && !cards ? "opacity-40" : ""}`}
                >
                  {cards ? (
                    <>
                      {s.said && (
                        <span className="absolute -top-1.5 left-1/2 z-10 -translate-x-1/2 rounded bg-amber-500 px-1 text-[8px] font-semibold leading-tight text-white">
                          said
                        </span>
                      )}
                      <span className={`flex gap-0.5 ${s.said ? "opacity-60" : ""}`}>
                        <PlayingCard card={cards[0]} size="xs" />
                        <PlayingCard card={cards[1]} size="xs" />
                      </span>
                    </>
                  ) : s.hidden ? (
                    <>
                      <CardBack size="xs" />
                      <CardBack size="xs" />
                    </>
                  ) : (
                    <>
                      <EmptySlot size="xs" />
                      <EmptySlot size="xs" />
                    </>
                  )}
                </span>
              )}
              <SeatChip s={s} dim={Boolean(dim)} toAct={toAct === n} selected={Boolean(isSel)} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function SeatChip({ s, dim, toAct, selected }: { s: SeatView; dim: boolean; toAct: boolean; selected: boolean }) {
  if (s.kind === "empty") {
    return (
      <span
        className={[
          "flex h-10 w-[4.25rem] flex-col items-center justify-center rounded-lg border border-dashed text-[11px]",
          selected ? "border-accent bg-accent/15 text-foreground" : "border-white/40 bg-black/20 text-white/70",
        ].join(" ")}
      >
        <span className="font-semibold tabular-nums">{s.seat}</span>
        <span className="text-[9px] leading-none">empty</span>
      </span>
    );
  }
  const hero = s.kind === "hero";
  return (
    <span
      className={[
        "relative flex w-[4.25rem] flex-col items-center rounded-lg border px-1 py-0.5 text-center shadow transition",
        hero ? "border-accent bg-surface ring-2 ring-accent" : "border-line bg-surface",
        selected && !hero ? "ring-2 ring-amber-400" : "",
        toAct ? "outline outline-2 outline-offset-2 outline-amber-400" : "",
        dim ? "opacity-45" : "",
      ].join(" ")}
    >
      <span className="flex w-full items-center justify-between gap-0.5 text-[9px] leading-tight text-muted">
        <span className="tabular-nums">{s.seat}</span>
        {s.position && <span className="font-semibold text-foreground/80">{s.position}</span>}
        {s.colors && s.colors.length > 0 && (
          <span className="flex gap-px">
            {s.colors.slice(0, 3).map((c, i) => (
              <span key={i} className="size-1.5 rounded-full" style={{ backgroundColor: c }} />
            ))}
          </span>
        )}
      </span>
      <span className={`w-full truncate text-[11px] leading-tight ${s.kind === "unknown" ? "font-medium italic text-muted" : "font-semibold"}`}>
        {hero ? "You" : s.kind === "unknown" ? (s.name ?? "?") : s.name}
      </span>
      {(s.sub || s.sittingOut) && (
        <span className="w-full truncate text-[9px] leading-tight text-muted">{s.sub ?? "sitting out"}</span>
      )}
    </span>
  );
}

export type BoardStreet = "flop" | "turn" | "river";

/** Which street a board card belongs to: the first three are the flop. */
export function streetOfCard(i: number): BoardStreet {
  return i < 3 ? "flop" : i === 3 ? "turn" : "river";
}

function EmptySlot({ size }: { size: "xs" | "sm" }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center border border-dashed border-white/60 bg-black/15 text-white/80 ${
        size === "xs" ? "h-5 w-4 rounded-[3px] text-[9px]" : "h-9 w-7 rounded text-sm"
      }`}
    >
      +
    </span>
  );
}

/**
 * The board and the pot, for the middle of the felt. With `onBoard`, each
 * card is a button for its street, and `slots` (up to five) draws empty
 * places for the cards still to come.
 */
export function FeltCenter({
  board,
  pot,
  note,
  onBoard,
  slots = 0,
  money = (x: number) => fmt(x),
  onPot,
  under,
}: {
  board: string[];
  pot?: number | null;
  /** How the pot is written (chips by default). */
  money?: (x: number) => string;
  /** Tapping the pot (e.g. to switch € / bb). */
  onPot?: () => void;
  /** A line under the pot (pot odds). */
  under?: ReactNode;
  note?: string | null;
  onBoard?: (street: BoardStreet) => void;
  slots?: number;
}) {
  const shown = Math.max(board.length, onBoard ? Math.min(slots, 5) : 0);
  return (
    <>
      {shown > 0 && (
        <span className="inline-flex gap-0.5">
          {Array.from({ length: shown }, (_, i) => {
            const c = board[i];
            // An empty place is only open for the next street to fill.
            const open = c || i === board.length || (board.length < 3 && i < 3);
            const face = c ? <PlayingCard card={c} size="sm" /> : <EmptySlot size="sm" />;
            if (!onBoard || !open) return <span key={c ?? `slot-${i}`} className={c ? "" : "opacity-40"}>{face}</span>;
            return (
              <button
                key={c ?? `slot-${i}`}
                type="button"
                onClick={() => onBoard(streetOfCard(i))}
                aria-label={c ? `Change the ${streetOfCard(i)}` : `Add the ${streetOfCard(i)}`}
                className="rounded"
              >
                {face}
              </button>
            );
          })}
        </span>
      )}
      {pot != null && pot > 0 &&
        (onPot ? (
          <button type="button" onClick={onPot} className="rounded-full bg-black/45 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-white" title="€ / bb">
            Pot {money(pot)}
          </button>
        ) : (
          <span className="rounded-full bg-black/45 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-white">Pot {money(pot)}</span>
        ))}
      {under}
      {note && <span className="text-[11px] text-white/75">{note}</span>}
    </>
  );
}
