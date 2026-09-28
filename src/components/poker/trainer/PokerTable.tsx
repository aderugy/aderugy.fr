"use client";

import type { CSSProperties } from "react";
import { comboCards } from "@/lib/solver/cards";
import type { Seat } from "@/lib/solver/seats";
import type { ActionKind } from "@/lib/solver/types";
import { seatsFromHero, type Scene } from "@/lib/trainer/scene";
import { CardBack, PlayingCard } from "@/components/poker/trainer/Cards";

/**
 * Seat anchors (percent of the table box), clockwise from hero at the bottom.
 * Landscape from `sm` up; a taller oval on phones.
 */
const WIDE = [
  [50, 90],
  [9, 70],
  [9, 26],
  [50, 9],
  [91, 26],
  [91, 70],
];
const TALL = [
  [50, 91],
  [13, 71],
  [13, 29],
  [50, 8],
  [87, 29],
  [87, 71],
];

/** Where a seat's bet sits on phones: beside the board, never over it. */
const TALL_BETS = [
  [50, 67],
  [25, 62],
  [20, 48],
  [50, 19],
  [80, 48],
  [75, 62],
];

const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(x < 10 ? 2 : 1).replace(/\.?0+$/, ""));

function anchor(i: number, bet = false): CSSProperties {
  const [wx, wy] = WIDE[i];
  const [tx, ty] = bet ? TALL_BETS[i] : TALL[i];
  // Landscape: a bet sits 30% of the way from the seat to the centre; hero's
  // further in, above his cards.
  const k = i === 0 ? 0.55 : 0.3;
  const lerp = (a: number) => (bet ? a + (50 - a) * k : a);
  return {
    "--wx": `${lerp(wx)}%`,
    "--wy": `${lerp(wy)}%`,
    "--tx": `${tx}%`,
    "--ty": `${ty}%`,
  } as CSSProperties;
}

const POS = "absolute -translate-x-1/2 -translate-y-1/2 left-(--tx) top-(--ty) sm:left-(--wx) sm:top-(--wy)";

/** The seat's anchor under another name (`s` = where chips come from, `g` = where the pot goes). */
function seatVars(i: number, prefix: "s" | "g"): CSSProperties {
  const [wx, wy] = WIDE[i];
  const [tx, ty] = TALL[i];
  return {
    [`--${prefix}wx`]: `${wx}%`,
    [`--${prefix}wy`]: `${wy}%`,
    [`--${prefix}tx`]: `${tx}%`,
    [`--${prefix}ty`]: `${ty}%`,
  } as CSSProperties;
}

const BUBBLE: Record<ActionKind, string> = {
  fold: "bg-zinc-500",
  check: "bg-slate-600",
  call: "bg-sky-600",
  bet: "bg-rose-600",
  raise: "bg-rose-700",
};

/**
 * `fit` sizes the table to its container on phones instead of to the width:
 * the parent must be a size container (`container-type: size`), and the table
 * takes the largest 3:4 box that fits in it, so the drill never scrolls.
 */
export function PokerTable({
  scene,
  combo,
  villainCombo = null,
  fit = false,
  handKey = "",
  bubble = null,
  sweep = false,
  dealt = [],
  toAct = null,
  winner = null,
}: {
  scene: Scene;
  combo: string | null;
  /** Shown face up at showdown. */
  villainCombo?: string | null;
  fit?: boolean;
  /** Changes with every hand, so its cards are dealt again. */
  handKey?: string;
  /** What a seat just did, shown by it. */
  bubble?: { seat: Seat; text: string; kind: ActionKind } | null;
  /** Bets in front fly into the pot. */
  sweep?: boolean;
  /** Board cards being dealt (they come in one after the other). */
  dealt?: string[];
  /** The seat whose turn it is. */
  toAct?: Seat | null;
  /** The hand is won without showdown: the pot goes to this seat, the other mucks. */
  winner?: Seat | null;
}) {
  const hero = scene.seats.find((s) => s.role === "hero");
  const order = hero ? seatsFromHero(hero.seat) : scene.seats.map((s) => s.seat);
  const bySeat = new Map(scene.seats.map((s) => [s.seat, s]));
  const heroCards = combo ? comboCards(combo) : null;
  const winnerIndex = winner ? order.indexOf(winner) : -1;

  return (
    <div
      className={[
        "relative mx-auto aspect-[3/4] w-full max-w-md select-none sm:aspect-[16/9] sm:max-w-3xl",
        fit ? "max-sm:w-[min(100cqw,75cqh)] max-sm:max-w-none" : "",
      ].join(" ")}
    >
      {/* Felt */}
      <div
        className="absolute inset-[9%] rounded-[50%] border-[6px] border-[#5b3a1e] shadow-inner sm:inset-x-[7%] sm:inset-y-[13%]"
        style={{ background: "radial-gradient(ellipse at center, #2f7d4f 0%, #1f5c3a 70%, #184a2f 100%)" }}
      />

      {/* Board + pot */}
      <div className="absolute left-1/2 top-[40%] flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 [perspective:600px]">
        {scene.board.length > 0 && (
          <span className="inline-flex gap-0.5">
            {scene.board.map((c) => {
              const k = dealt.indexOf(c);
              return (
                <span key={`${handKey}-${c}`} className="trn-deal" style={{ animationDelay: `${Math.max(0, k) * 110}ms` }}>
                  <PlayingCard card={c} size="md" />
                </span>
              );
            })}
          </span>
        )}
        <span
          key={`pot-${scene.centerBb}`}
          className={[
            "trn-bump rounded-full bg-black/40 px-3 py-0.5 text-xs font-semibold tabular-nums text-white transition-opacity",
            winner ? "opacity-40" : "",
          ].join(" ")}
        >
          Pot {fmt(scene.centerBb)} bb
          {scene.totalPotBb !== scene.centerBb && (
            <span className="font-normal text-white/70"> · total {fmt(scene.totalPotBb)}</span>
          )}
        </span>
      </div>

      {/* The pot on its way to the winner */}
      {winnerIndex >= 0 && (
        <div
          key={`win-${handKey}`}
          className="trn-to trn-pot-win absolute z-30 -translate-x-1/2 -translate-y-1/2"
          style={{ left: "50%", top: "47%", ...seatVars(winnerIndex, "g") }}
        >
          <span className="flex items-center gap-1 rounded-full bg-amber-400 px-2.5 py-0.5 text-xs font-bold tabular-nums text-black shadow">
            +{fmt(scene.totalPotBb)}
          </span>
        </div>
      )}

      {order.map((seatName, i) => {
        const seat = bySeat.get(seatName)!;
        const folded = seat.role === "folded";
        const mucks = winner != null && seat.role !== "folded" && seatName !== winner;
        const top = (TALL[i][1] + WIDE[i][1]) / 2 < 50;
        return (
          <div key={seatName}>
            {/* Bet in front: slides in from the seat, swept into the pot when the round closes */}
            {seat.bet > 0 && (
              <div
                key={`${handKey}-${seatName}-${seat.bet}`}
                className={`${POS} trn-from z-10 ${winner ? "trn-muck" : sweep ? "trn-sweep" : "trn-chip-in"}`}
                style={{ ...anchor(i, true), ...seatVars(i, "s") }}
              >
                <span className="flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white">
                  <span className="inline-block size-2.5 rounded-full border border-white/70 bg-amber-400" />
                  {fmt(seat.bet)}
                </span>
              </div>
            )}

            {/* Seat */}
            <div className={`${POS} z-20 flex flex-col items-center`} style={anchor(i)}>
              {bubble && bubble.seat === seatName && (
                <span
                  key={`${bubble.text}-${scene.line.length}`}
                  className={[
                    "trn-pop absolute left-1/2 z-40 -translate-x-1/2 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold text-white shadow-lg",
                    top ? "top-full mt-1.5" : "bottom-full mb-1.5",
                    BUBBLE[bubble.kind],
                  ].join(" ")}
                >
                  {bubble.text}
                </span>
              )}
              {seat.role === "hero" && heroCards && (
                <div key={`${handKey}-hero`} className={`mb-1 flex gap-1 ${mucks ? "trn-muck" : ""}`}>
                  <span className="trn-deal-hole">
                    <PlayingCard card={heroCards[0]} size="lg" />
                  </span>
                  <span className="trn-deal-hole" style={{ animationDelay: "90ms" }}>
                    <PlayingCard card={heroCards[1]} size="lg" />
                  </span>
                </div>
              )}
              {seat.role === "villain" && (
                <div key={`${handKey}-villain`} className={`mb-1 flex gap-0.5 [perspective:400px] ${mucks ? "trn-muck" : ""}`}>
                  {villainCombo ? (
                    <>
                      <span key={villainCombo} className="trn-flip">
                        <PlayingCard card={comboCards(villainCombo)[0]} size="sm" />
                      </span>
                      <span className="trn-flip" style={{ animationDelay: "80ms" }}>
                        <PlayingCard card={comboCards(villainCombo)[1]} size="sm" />
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="trn-deal-hole">
                        <CardBack size="sm" />
                      </span>
                      <span className="trn-deal-hole" style={{ animationDelay: "90ms" }}>
                        <CardBack size="sm" />
                      </span>
                    </>
                  )}
                </div>
              )}
              <div
                className={[
                  "relative min-w-16 rounded-lg border px-2 py-1 text-center shadow transition-colors",
                  seat.role === "hero"
                    ? "border-accent bg-surface ring-2 ring-accent"
                    : seat.role === "villain"
                      ? "border-amber-500 bg-surface"
                      : "border-line bg-surface/70 opacity-50",
                  toAct === seatName ? "trn-turn" : "",
                ].join(" ")}
              >
                <div className="text-[11px] font-semibold leading-tight">{seatName}</div>
                <div className="text-[10px] tabular-nums leading-tight text-muted">
                  {folded ? "folded" : `${fmt(seat.stack)} bb`}
                </div>
                {seat.isButton && (
                  <span className="absolute -right-2 -top-2 flex size-5 items-center justify-center rounded-full border border-black/20 bg-white text-[10px] font-bold text-black shadow">
                    D
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
