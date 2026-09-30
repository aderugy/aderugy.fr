"use client";

import { GRID_HANDS, RANKS, comboBlocked, handCombos } from "@/lib/solver/cards";
import { comboVector, handDisplayVector, vectorTotal } from "@/lib/solver/strategy";
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

/** Combos of the range outside the category looked at. */
const OUTSIDE = "#c9c6c0";

/**
 * A hand's cell when only some combos are looked at (a category): their
 * strategy, then the hand's other combos in range in grey, all out of the
 * hand's combos like `handDisplayVector`. The extra last entry is the grey.
 */
function focusVector(weights: StrategyWeights, hand: string, len: number, focus: Set<string>): number[] | null {
  const combos = handCombos(hand);
  const out = new Array<number>(len + 1).fill(0);
  let any = false;
  for (const c of combos) {
    const v = comboVector(weights, c, hand, len);
    const total = vectorTotal(v);
    if (total <= 0) continue;
    any = true;
    if (focus.has(c)) for (let i = 0; i < len; i++) out[i] += v[i];
    else out[len] += total;
  }
  return any ? out.map((x) => x / combos.length) : null;
}

/**
 * A read-only 13×13 strategy grid. `mini` drops labels and borders for the tiny
 * in-bubble preview; the full variant shows hand labels and reports the hovered
 * hand so a caller can surface per-combo detail. `isolate` keeps one action's
 * share of every cell, to see which hands take it.
 */
export function StrategyGrid({
  actions,
  weights,
  dead,
  variant = "full",
  hovered,
  onHoverHand,
  isolate = null,
  focus = null,
}: {
  actions: StrategyAction[];
  weights: StrategyWeights;
  dead: Set<string>;
  variant?: "mini" | "full";
  hovered?: string | null;
  onHoverHand?: (hand: string | null) => void;
  /** Show only this action's share of each hand (index in `actions`). */
  isolate?: number | null;
  /** Only these combos in colour; the rest of the range in grey. */
  focus?: Set<string> | null;
}) {
  const len = actions.length;
  const shown: StrategyAction[] = focus ? [...actions, { id: "__outside", kind: "check", label: "Other", color: OUTSIDE }] : actions;
  const mini = variant === "mini";
  return (
    <div
      className={mini ? "grid gap-px" : "grid select-none gap-0.5"}
      style={{ gridTemplateColumns: `repeat(${RANKS.length}, minmax(0, 1fr))` }}
      onPointerLeave={() => onHoverHand?.(null)}
    >
      {GRID_HANDS.map((hand) => {
        const full = focus ? focusVector(weights, hand, len, focus) : handDisplayVector(weights, hand, len);
        const vec =
          full && isolate != null ? full.map((x, i) => (i === isolate || i === len ? x : 0)) : full;
        const blocked = handCombos(hand).every((c) => comboBlocked(c, dead));
        return (
          <div
            key={hand}
            title={mini ? undefined : hand}
            onPointerEnter={onHoverHand ? () => onHoverHand(hand) : undefined}
            className={[
              "relative aspect-square overflow-hidden",
              mini ? "" : "rounded-sm border text-[10px] font-semibold sm:text-[13px]",
              mini ? "" : hovered === hand ? "border-accent ring-1 ring-accent" : "border-line",
              blocked ? "opacity-25" : "",
            ].join(" ")}
          >
            <CellBars actions={shown} vector={vec} />
            {!mini && (
              <span className="absolute inset-0 flex items-center justify-center text-black">
                {hand}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
