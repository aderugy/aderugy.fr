"use client";

import { useMemo, useState } from "react";
import { GRID_HANDS, RANKS, comboBlocked, handCombos } from "@/lib/solver/cards";
import type { PlayerStats, StrategyStats } from "@/lib/solver/types";
import { fmtBb } from "@/lib/solver/gameState";

/**
 * Solver numbers on the 13×13 grid: a player's equity (red → amber → green)
 * or the acting player's EV. A hand's value is the average of its combos
 * weighted by how much of each is in range; hands out of range stay blank.
 */

export type StatsMode = { kind: "equity"; player: "OOP" | "IP" } | { kind: "ev" };

type HandValue = { value: number; weight: number };

/** Range-weighted average of per-combo values, by hand. */
export function handValues(
  values: Record<string, number>,
  range: Record<string, number>,
  dead: Set<string>,
): Map<string, HandValue> {
  const out = new Map<string, HandValue>();
  for (const hand of GRID_HANDS) {
    let sum = 0;
    let w = 0;
    for (const c of handCombos(hand)) {
      if (comboBlocked(c, dead)) continue;
      const r = range[c] ?? 0;
      const v = values[c];
      if (r <= 0 || v == null) continue;
      sum += v * r;
      w += r;
    }
    if (w > 0) out.set(hand, { value: sum / w, weight: w });
  }
  return out;
}

const RED = [210, 59, 59];
const AMBER = [224, 170, 30];
const GREEN = [31, 157, 85];

function mix(a: number[], b: number[], t: number): string {
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** 0 → red, 0.5 → amber, 1 → green. */
export function scaleColor(t: number): string {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? mix(RED, AMBER, x * 2) : mix(AMBER, GREEN, (x - 0.5) * 2);
}

function selection(stats: StrategyStats, mode: StatsMode): { values: Record<string, number>; range: Record<string, number> } | null {
  if (mode.kind === "equity") {
    const p: PlayerStats | undefined = stats.players[mode.player];
    return p ? { values: p.equity, range: p.range } : null;
  }
  const actor = stats.players[stats.actor];
  return stats.ev && actor ? { values: stats.ev.node, range: actor.range } : null;
}

export function StatsGrid({
  stats,
  mode,
  dead,
  hovered,
  onHoverHand,
}: {
  stats: StrategyStats;
  mode: StatsMode;
  dead: Set<string>;
  hovered?: string | null;
  onHoverHand?: (hand: string | null) => void;
}) {
  const sel = selection(stats, mode);
  const cells = useMemo(() => (sel ? handValues(sel.values, sel.range, dead) : new Map<string, HandValue>()), [sel, dead]);
  // EV runs from the lowest to the highest hand; equity is absolute.
  const [lo, hi] = useMemo(() => {
    if (mode.kind === "equity") return [0, 100];
    const vs = [...cells.values()].map((c) => c.value);
    return vs.length ? [Math.min(...vs), Math.max(...vs)] : [0, 1];
  }, [cells, mode.kind]);

  if (!sel) return <p className="text-sm text-muted">Not in this import.</p>;
  return (
    <div
      className="grid select-none gap-0.5"
      style={{ gridTemplateColumns: `repeat(${RANKS.length}, minmax(0, 1fr))` }}
      onPointerLeave={() => onHoverHand?.(null)}
    >
      {GRID_HANDS.map((hand) => {
        const c = cells.get(hand);
        const t = c ? (hi > lo ? (c.value - lo) / (hi - lo) : 1) : 0;
        return (
          <div
            key={hand}
            title={c ? `${hand}: ${mode.kind === "equity" ? `${c.value.toFixed(1)}%` : `${fmtBb(c.value)} bb`}` : hand}
            onPointerEnter={onHoverHand ? () => onHoverHand(hand) : undefined}
            className={[
              "relative flex aspect-square flex-col items-center justify-center overflow-hidden rounded-sm border leading-none",
              hovered === hand ? "border-accent ring-1 ring-accent" : "border-line",
              c ? "text-white" : "bg-background text-muted/50",
            ].join(" ")}
            style={c ? { backgroundColor: scaleColor(t), opacity: 0.45 + 0.55 * Math.min(1, c.weight / handCombos(hand).length) } : undefined}
          >
            <span className="text-[8px] font-semibold opacity-90 sm:text-[9px]">{hand}</span>
            {c && (
              <span className="mt-px text-[8px] tabular-nums sm:text-[9px]">
                {mode.kind === "equity" ? Math.round(c.value) : fmtBb(c.value)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Equity / EV of the whole range, for the legend. */
export function rangeTotal(stats: StrategyStats, mode: StatsMode): string | null {
  if (mode.kind === "equity") {
    const t = stats.players[mode.player]?.equityTotal;
    return t == null ? null : `${t.toFixed(1)}%`;
  }
  return stats.ev?.total == null ? null : `${fmtBb(stats.ev.total)} bb`;
}

/** The grid plus the hovered hand's combos. */
export function StatsDetail({
  stats,
  mode,
  dead,
}: {
  stats: StrategyStats;
  mode: StatsMode;
  dead: Set<string>;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const sel = selection(stats, mode);
  const combos = hovered ? handCombos(hovered).filter((c) => !comboBlocked(c, dead) && (sel?.range[c] ?? 0) > 0) : [];
  return (
    <div>
      <StatsGrid stats={stats} mode={mode} dead={dead} hovered={hovered} onHoverHand={setHovered} />
      <div className="mt-3 min-h-[15rem] border-t border-line pt-3 text-xs">
        {!hovered ? (
          <p className="text-muted">Hover a hand to see its combos.</p>
        ) : combos.length === 0 ? (
          <p className="text-muted">{hovered}: not in range here.</p>
        ) : (
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 tabular-nums">
            {combos.map((c) => (
              <ComboRow key={c} combo={c} stats={stats} mode={mode} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ComboRow({ combo, stats, mode }: { combo: string; stats: StrategyStats; mode: StatsMode }) {
  const sel = selection(stats, mode);
  const v = sel?.values[combo];
  const reach = sel?.range[combo] ?? 0;
  return (
    <>
      <span className="font-medium">{combo}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-foreground/5">
        {v != null && (
          <span
            className="block h-full rounded-full"
            style={{ width: `${mode.kind === "equity" ? Math.min(100, v) : 100}%`, backgroundColor: scaleColor(mode.kind === "equity" ? v / 100 : 1) }}
          />
        )}
      </span>
      <span className="text-right">
        {v == null ? "—" : mode.kind === "equity" ? `${v.toFixed(1)}%` : `${fmtBb(v)} bb`}
        <span className="ml-2 text-muted">{Math.round(reach * 100)}% in range</span>
      </span>
    </>
  );
}
