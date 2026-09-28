"use client";

import { useMemo, useState } from "react";
import { comboBlocked, handCombos } from "@/lib/solver/cards";
import { comboVector, handDisplayVector, vectorTotal, zeroVector } from "@/lib/solver/strategy";
import type { StrategyAction, StrategyWeights } from "@/lib/solver/types";
import { StrategyGrid } from "@/components/poker/StrategyGrid";
import { formatFrequency } from "@/components/poker/NodeCard";

/**
 * Read-only strategy view for study mode: the legend with each action's global
 * frequency, the big grid, and the hovered hand's aggregate and per-combo
 * detail under it. Hovering a legend entry (or setting `isolate` from outside)
 * shows only that action in the grid.
 */
export function StrategyDetail({
  actions,
  weights,
  dead,
  frequencies,
  isolate,
  onIsolate,
}: {
  actions: StrategyAction[];
  weights: StrategyWeights;
  dead: Set<string>;
  /** Global frequency of each action, in %; null when the grid is empty. */
  frequencies?: number[] | null;
  isolate?: number | null;
  onIsolate?: (index: number | null) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  if (actions.length === 0) return <p className="text-sm text-muted">This decision has no options yet.</p>;
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 pb-3">
        {actions.map((a, i) => (
          <button
            key={a.id}
            type="button"
            onPointerEnter={() => onIsolate?.(i)}
            onPointerLeave={() => onIsolate?.(null)}
            onFocus={() => onIsolate?.(i)}
            onBlur={() => onIsolate?.(null)}
            className={[
              "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
              isolate === i ? "border-foreground/40 bg-background" : "border-line",
              isolate != null && isolate !== i ? "opacity-50" : "",
            ].join(" ")}
          >
            <span className="size-3 rounded-sm" style={{ backgroundColor: a.color }} />
            <span className="font-medium">{a.label}</span>
            {frequencies && (
              <span className="tabular-nums text-muted">{formatFrequency(frequencies[i] ?? 0)}</span>
            )}
          </button>
        ))}
      </div>

      <StrategyGrid
        actions={actions}
        weights={weights}
        dead={dead}
        hovered={hovered}
        onHoverHand={setHovered}
        isolate={isolate}
      />

      <HoverDetail hand={hovered} actions={actions} weights={weights} dead={dead} />
    </div>
  );
}

function HoverDetail({
  hand,
  actions,
  weights,
  dead,
}: {
  hand: string | null;
  actions: StrategyAction[];
  weights: StrategyWeights;
  dead: Set<string>;
}) {
  const len = actions.length;
  const combos = useMemo(
    () => (hand ? handCombos(hand).filter((c) => !comboBlocked(c, dead)) : []),
    [hand, dead],
  );

  if (!hand) {
    return (
      <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
        Hover a hand to see its combo breakdown.
      </p>
    );
  }

  const handVec = handDisplayVector(weights, hand, len) ?? zeroVector(len);

  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      <div>
        <h4 className="text-sm font-medium">{hand}</h4>
        <div className="mt-1">
          <WeightBars actions={actions} vector={handVec} />
        </div>
      </div>

      <div>
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
          Combos ({combos.length})
        </p>
        <div className="space-y-1.5">
          {combos.map((combo) => (
            <div key={combo} className="flex items-center gap-2">
              <span className="w-10 shrink-0 text-[11px] font-medium tabular-nums">{combo}</span>
              <div className="flex-1">
                <WeightBars actions={actions} vector={comboVector(weights, combo, hand, len)} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** One horizontal bar of the distribution with inline percentages. */
function WeightBars({ actions, vector }: { actions: StrategyAction[]; vector: number[] }) {
  const total = Math.max(vectorTotal(vector), 1);
  return (
    <div className="flex h-4 overflow-hidden rounded-sm border border-line bg-background">
      {actions.map((action, i) => {
        const pct = ((vector[i] ?? 0) / total) * 100;
        if (pct <= 0) return null;
        return (
          <span
            key={action.id}
            className="flex items-center justify-center text-[9px] text-white"
            style={{ width: `${pct}%`, backgroundColor: action.color }}
            title={`${action.label}: ${Math.round(vector[i] ?? 0)}`}
          >
            {pct > 14 ? Math.round(vector[i] ?? 0) : ""}
          </span>
        );
      })}
    </div>
  );
}
