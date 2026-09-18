"use client";

import { GRID_HANDS, RANKS, comboBlocked, handCombos } from "@/lib/solver/cards";
import { handDisplayVector, vectorTotal } from "@/lib/solver/strategy";
import type { StrategyAction, StrategyWeights } from "@/lib/solver/types";

/**
 * The colour bars that fill one hand cell. Actions sit side by side in
 * proportion to each other; when the frequencies sum to less than 100% (the
 * hand is only partly in range) the bars fill that share of the cell's height,
 * from the bottom up, and the rest stays background grey.
 */
export function CellBars({
  actions,
  vector,
}: {
  actions: StrategyAction[];
  vector: number[] | null;
}) {
  const total = vector ? vectorTotal(vector) : 0;
  if (!vector || total <= 0) return <span className="absolute inset-0 bg-background" />;
  const height = Math.min(100, total);
  return (
    <span className="absolute inset-0 flex flex-col justify-end bg-background">
      <span className="flex w-full" style={{ height: `${height}%` }}>
        {actions.map((action, i) => {
          const w = ((vector[i] ?? 0) / total) * 100;
          if (w <= 0) return null;
          return (
            <span key={action.id} style={{ width: `${w}%`, backgroundColor: action.color }} />
          );
        })}
      </span>
    </span>
  );
}

/**
 * A read-only 13×13 strategy grid. `mini` drops labels and borders for the tiny
 * in-bubble preview; the full variant shows hand labels and reports the hovered
 * hand so a caller can surface per-combo detail.
 */
export function StrategyGrid({
  actions,
  weights,
  dead,
  variant = "full",
  hovered,
  onHoverHand,
}: {
  actions: StrategyAction[];
  weights: StrategyWeights;
  dead: Set<string>;
  variant?: "mini" | "full";
  hovered?: string | null;
  onHoverHand?: (hand: string | null) => void;
}) {
  const len = actions.length;
  const mini = variant === "mini";
  return (
    <div
      className={mini ? "grid gap-px" : "grid select-none gap-0.5"}
      style={{ gridTemplateColumns: `repeat(${RANKS.length}, minmax(0, 1fr))` }}
      onPointerLeave={() => onHoverHand?.(null)}
    >
      {GRID_HANDS.map((hand) => {
        const vec = handDisplayVector(weights, hand, len);
        const blocked = handCombos(hand).every((c) => comboBlocked(c, dead));
        return (
          <div
            key={hand}
            title={mini ? undefined : hand}
            onPointerEnter={onHoverHand ? () => onHoverHand(hand) : undefined}
            className={[
              "relative aspect-square overflow-hidden",
              mini ? "" : "rounded-sm border text-[9px] font-semibold",
              mini ? "" : hovered === hand ? "border-accent ring-1 ring-accent" : "border-line",
              blocked ? "opacity-25" : "",
            ].join(" ")}
          >
            <CellBars actions={actions} vector={vec} />
            {!mini && (
              <span className="absolute inset-0 flex items-center justify-center text-white mix-blend-difference">
                {hand}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
