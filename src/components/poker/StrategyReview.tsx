"use client";

import { useMemo, useState } from "react";
import { comboBlocked, handCombos } from "@/lib/solver/cards";
import { comboVector, handDisplayVector, vectorTotal, zeroVector } from "@/lib/solver/strategy";
import type { StrategyAction, StrategyWeights } from "@/lib/solver/types";
import { StrategyGrid } from "@/components/poker/StrategyGrid";

/**
 * Read-only strategy view for revision mode. The big grid lives in the right
 * drawer; hovering a cell surfaces that hand's aggregate and per-combo detail
 * below it.
 */
export function StrategyReview({
  title,
  actions,
  weights,
  dead,
  onClose,
}: {
  title: string;
  actions: StrategyAction[];
  weights: StrategyWeights;
  dead: Set<string>;
  onClose: () => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <aside className="absolute right-0 top-0 z-20 flex h-full w-[26rem] max-w-full flex-col border-l border-line bg-surface shadow-xl">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">
          {title}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-xs text-muted hover:text-foreground"
        >
          Close
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {actions.length === 0 ? (
          <p className="text-sm text-muted">This strategy has no actions yet.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 pb-3">
              {actions.map((a) => (
                <span key={a.id} className="flex items-center gap-1 text-[11px] text-muted">
                  <span className="size-3 rounded-sm" style={{ backgroundColor: a.color }} />
                  {a.label}
                </span>
              ))}
            </div>

            <StrategyGrid
              actions={actions}
              weights={weights}
              dead={dead}
              hovered={hovered}
              onHoverHand={setHovered}
            />

            <HoverDetail hand={hovered} actions={actions} weights={weights} dead={dead} />
          </>
        )}
      </div>
    </aside>
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
