"use client";

import type { CSSProperties } from "react";
import { comboCards } from "@/lib/solver/cards";
import { seatsFromHero, type Scene } from "@/lib/trainer/scene";
import { BoardCards, CardBack, PlayingCard } from "@/components/poker/trainer/Cards";

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
  [50, 75],
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
  // Landscape: a bet sits 30% of the way from the seat to the centre.
  const lerp = (a: number) => (bet ? a + (50 - a) * 0.3 : a);
  return {
    "--wx": `${lerp(wx)}%`,
    "--wy": `${lerp(wy)}%`,
    "--tx": `${tx}%`,
    "--ty": `${ty}%`,
  } as CSSProperties;
}

const POS = "absolute -translate-x-1/2 -translate-y-1/2 left-(--tx) top-(--ty) sm:left-(--wx) sm:top-(--wy)";

export function PokerTable({ scene, combo }: { scene: Scene; combo: string | null }) {
  const hero = scene.seats.find((s) => s.role === "hero");
  const order = hero ? seatsFromHero(hero.seat) : scene.seats.map((s) => s.seat);
  const bySeat = new Map(scene.seats.map((s) => [s.seat, s]));
  const heroCards = combo ? comboCards(combo) : null;

  return (
    <div className="relative mx-auto aspect-[3/4] w-full max-w-md select-none sm:aspect-[16/9] sm:max-w-3xl">
      {/* Felt */}
      <div
        className="absolute inset-[9%] rounded-[50%] border-[6px] border-[#5b3a1e] shadow-inner sm:inset-x-[7%] sm:inset-y-[13%]"
        style={{ background: "radial-gradient(ellipse at center, #2f7d4f 0%, #1f5c3a 70%, #184a2f 100%)" }}
      />

      {/* Board + pot */}
      <div className="absolute left-1/2 top-[40%] flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2">
        {scene.board.length > 0 && <BoardCards cards={scene.board} size="md" />}
        <span className="rounded-full bg-black/40 px-3 py-0.5 text-xs font-semibold tabular-nums text-white">
          Pot {fmt(scene.centerBb)} bb
          {scene.totalPotBb !== scene.centerBb && (
            <span className="font-normal text-white/70"> · total {fmt(scene.totalPotBb)}</span>
          )}
        </span>
      </div>

      {order.map((seatName, i) => {
        const seat = bySeat.get(seatName)!;
        const folded = seat.role === "folded";
        return (
          <div key={seatName}>
            {/* Bet in front */}
            {seat.bet > 0 && (
              <div className={`${POS} z-10`} style={anchor(i, true)}>
                <span className="flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white">
                  <span className="inline-block size-2.5 rounded-full border border-white/70 bg-amber-400" />
                  {fmt(seat.bet)}
                </span>
              </div>
            )}

            {/* Seat */}
            <div className={`${POS} z-20 flex flex-col items-center`} style={anchor(i)}>
              {seat.role === "hero" && heroCards && (
                <div className="mb-1 flex gap-1">
                  <PlayingCard card={heroCards[0]} size="lg" />
                  <PlayingCard card={heroCards[1]} size="lg" />
                </div>
              )}
              {seat.role === "villain" && (
                <div className="mb-1 flex gap-0.5">
                  <CardBack size="sm" />
                  <CardBack size="sm" />
                </div>
              )}
              <div
                className={[
                  "relative min-w-16 rounded-lg border px-2 py-1 text-center shadow",
                  seat.role === "hero"
                    ? "border-accent bg-surface ring-2 ring-accent"
                    : seat.role === "villain"
                      ? "border-amber-500 bg-surface"
                      : "border-line bg-surface/70 opacity-50",
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
