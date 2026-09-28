"use client";

import { useMemo, useState } from "react";
import { comboBlocked, handCombos } from "@/lib/solver/cards";
import { comboVector, handDisplayVector, vectorTotal, zeroVector } from "@/lib/solver/strategy";
import type { StrategyAction, StrategyStats, StrategyWeights } from "@/lib/solver/types";
import { fmtBb } from "@/lib/solver/gameState";
import { StrategyGrid } from "@/components/poker/StrategyGrid";
import { formatFrequency } from "@/components/poker/format";

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
  stats,
}: {
  actions: StrategyAction[];
  weights: StrategyWeights;
  dead: Set<string>;
  /** Global frequency of each action, in %; null when the grid is empty. */
  frequencies?: number[] | null;
  isolate?: number | null;
  onIsolate?: (index: number | null) => void;
  /** Solver equity / EV (Pio imports): shown per combo on hover. */
  stats?: StrategyStats | null;
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
            {stats?.ev?.actionTotals[i] != null && (
              <span className="tabular-nums text-muted/80">· EV {fmtBb(stats.ev.actionTotals[i]!)}</span>
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

      <HoverDetail hand={hovered} actions={actions} weights={weights} dead={dead} stats={stats ?? null} />
    </div>
  );
}

function HoverDetail({
  hand,
  actions,
  weights,
  dead,
  stats,
}: {
  hand: string | null;
  actions: StrategyAction[];
  weights: StrategyWeights;
  dead: Set<string>;
  stats: StrategyStats | null;
}) {
  const len = actions.length;
  const combos = useMemo(
    () => (hand ? handCombos(hand).filter((c) => !comboBlocked(c, dead)) : []),
    [hand, dead],
  );

  if (!hand) {
    return (
      <p className="mt-3 min-h-[22rem] border-t border-line pt-3 text-xs text-muted">
        Hover a hand to see its combo breakdown.
      </p>
    );
  }

  const handVec = handDisplayVector(weights, hand, len) ?? zeroVector(len);
  const actor = stats ? stats.players[stats.actor] : undefined;
  // EV of each action for this hand: its combos in range, weighted by reach.
  const handActionEv = stats?.ev
    ? actions.map((_, i) => {
        let sum = 0;
        let w = 0;
        for (const c of combos) {
          const r = actor?.range[c] ?? 0;
          const v = stats.ev!.actions[c]?.[i];
          if (r > 0 && v != null) {
            sum += v * r;
            w += r;
          }
        }
        return w > 0 ? sum / w : null;
      })
    : null;

  return (
    // A fixed minimum height: hovering hands must not push what is below the
    // grid up and down (on a phone the options column sits there).
    <div className="mt-3 min-h-[22rem] space-y-3 border-t border-line pt-3">
      <div>
        <h4 className="text-sm font-medium">{hand}</h4>
        <div className="mt-1">
          <WeightBars actions={actions} vector={handVec} />
        </div>
        {handActionEv && handActionEv.some((v) => v != null) && (
          <p className="mt-1 flex flex-wrap gap-x-2 text-[11px] tabular-nums text-muted">
            EV by action:
            {actions.map((a, i) =>
              handActionEv[i] == null ? null : (
                <span key={a.id} className="inline-flex items-center gap-1">
                  <span className="size-2 rounded-sm" style={{ backgroundColor: a.color }} />
                  {a.label} <b className="font-medium text-foreground">{fmtBb(handActionEv[i]!)}</b>
                </span>
              ),
            )}
          </p>
        )}
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
              {stats && (
                <span className="w-24 shrink-0 text-right text-[11px] tabular-nums text-muted">
                  {actor?.equity[combo] != null ? `${actor.equity[combo].toFixed(1)}%` : "—"}
                  {stats.ev?.node[combo] != null ? ` · ${fmtBb(stats.ev.node[combo])}bb` : ""}
                </span>
              )}
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
