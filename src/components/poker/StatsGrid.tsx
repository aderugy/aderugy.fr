"use client";

import { useMemo, useState } from "react";
import { GRID_HANDS, RANKS, comboBlocked, handCombos } from "@/lib/solver/cards";
import type { StrategyStats } from "@/lib/solver/types";
import { fmtBb } from "@/lib/solver/gameState";

/**
 * Solver numbers on the 13×13 grid, in solid solver-style colours (red →
 * orange → yellow → green, black text):
 * - equity: a player's equity, yellow at 50%;
 * - EV: the acting player's EV, coloured by its share of the pot — green as
 *   soon as the hand wins more than half of it;
 * - EqR: equity realization, EV% / Eq with EV% = EV / pot — green above 100%.
 * Each cell is split into one stripe per combo in range (width ∝ reach), so
 * suit differences show at a glance; hands out of range stay blank.
 */

export type StatsMode = { kind: "equity"; player: "OOP" | "IP" } | { kind: "ev" } | { kind: "eqr" };

/**
 * What a mode averages: per combo `num / den`, and per hand
 * Σ reach·num / Σ reach·den (for EqR, the hand's EV% over its equity rather
 * than a mean of ratios, which blows up on combos with almost no equity).
 */
type Selection = {
  range: Record<string, number>;
  num: Record<string, number>;
  den: Record<string, number> | null;
};

type Stripe = { value: number; reach: number };
type HandValue = { value: number; weight: number; stripes: Stripe[] };

function selection(stats: StrategyStats, mode: StatsMode, potBb: number | null): Selection | null {
  if (mode.kind === "equity") {
    const p = stats.players[mode.player];
    return p ? { range: p.range, num: p.equity, den: null } : null;
  }
  const actor = stats.players[stats.actor];
  if (!stats.ev || !actor) return null;
  if (mode.kind === "ev") return { range: actor.range, num: stats.ev.node, den: null };
  if (!potBb || potBb <= 0) return null;
  // EqR (%) = EV% / Eq, with EV% = EV / pot × 100 and Eq as a 0–1 fraction.
  const num: Record<string, number> = {};
  const den: Record<string, number> = {};
  for (const [c, ev] of Object.entries(stats.ev.node)) {
    const eq = actor.equity[c];
    if (ev == null || eq == null) continue;
    num[c] = (ev / potBb) * 100;
    den[c] = eq / 100;
  }
  return { range: actor.range, num, den };
}

function comboValue(sel: Selection, combo: string): number | null {
  const n = sel.num[combo];
  if (n == null || !Number.isFinite(n)) return null;
  if (!sel.den) return n;
  const d = sel.den[combo];
  return d == null || d <= 0 ? null : n / d;
}

/** Range-weighted value of each hand, plus its combos for the stripes. */
function handValues(sel: Selection, dead: Set<string>): Map<string, HandValue> {
  const out = new Map<string, HandValue>();
  for (const hand of GRID_HANDS) {
    let n = 0;
    let d = 0;
    let w = 0;
    const stripes: Stripe[] = [];
    for (const c of handCombos(hand)) {
      if (comboBlocked(c, dead)) continue;
      const r = sel.range[c] ?? 0;
      const v = sel.num[c];
      if (r <= 0 || v == null || !Number.isFinite(v)) continue;
      const den = sel.den ? sel.den[c] : 1;
      if (den == null) continue;
      n += v * r;
      d += den * r;
      w += r;
      const cv = comboValue(sel, c);
      if (cv != null) stripes.push({ value: cv, reach: r });
    }
    if (w > 0 && d > 0) out.set(hand, { value: n / d, weight: w, stripes });
  }
  return out;
}

/* ---------- Colours ---------- */

type Stop = [at: number, rgb: [number, number, number]];

const RED: [number, number, number] = [214, 48, 39];
const ORANGE: [number, number, number] = [255, 122, 38];
const YELLOW: [number, number, number] = [255, 226, 30];
const LIME: [number, number, number] = [150, 224, 58];
const GREEN: [number, number, number] = [52, 180, 72];
const DEEP_GREEN: [number, number, number] = [30, 145, 60];

/** Equity in %: continuous, yellow at 50%. */
const EQUITY_STOPS: Stop[] = [
  [0, RED],
  [30, ORANGE],
  [50, YELLOW],
  [70, LIME],
  [100, GREEN],
];

/** EV in % of the pot: red → yellow up to half the pot, then straight to green. */
const EV_STOPS: Stop[] = [
  [0, RED],
  [25, ORANGE],
  [50, YELLOW],
  [50, LIME],
  [100, GREEN],
  [150, DEEP_GREEN],
];

/** EqR in %: under-realizing in red → yellow, over-realizing (> 100%) in green. */
const EQR_STOPS: Stop[] = [
  [0, RED],
  [60, ORANGE],
  [100, YELLOW],
  [100, LIME],
  [130, GREEN],
  [170, DEEP_GREEN],
];

function rgb(c: number[]): string {
  return `rgb(${c.map(Math.round).join(", ")})`;
}

/** Colour at `v` along `stops`; a repeated position is a hard switch (the later stop wins from it on). */
function ramp(stops: Stop[], v: number): string {
  if (!Number.isFinite(v) || v <= stops[0][0]) return rgb(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    const [b, cb] = stops[i];
    if (v < b) {
      const [a, ca] = stops[i - 1];
      const t = (v - a) / (b - a);
      return rgb(ca.map((x, k) => x + (cb[k] - x) * t));
    }
  }
  return rgb(stops[stops.length - 1][1]);
}

/**
 * Where a value sits for colouring, in the mode's own unit: equity %, EV % of
 * the pot, EqR %. Without a pot, EV falls back to the spread of the hands on
 * screen (worst → best), on the equity ramp.
 */
type Scale = { stops: Stop[]; at: (v: number) => number; /** End of the legend / combo bars. */ max: number };

function scaleFor(mode: StatsMode, potBb: number | null, lo: number, hi: number): Scale {
  if (mode.kind === "equity") return { stops: EQUITY_STOPS, at: (v) => v, max: 100 };
  if (mode.kind === "eqr") return { stops: EQR_STOPS, at: (v) => v, max: 200 };
  if (potBb && potBb > 0) return { stops: EV_STOPS, at: (v) => (v / potBb) * 100, max: 150 };
  return { stops: EQUITY_STOPS, at: (v) => (hi > lo ? ((v - lo) / (hi - lo)) * 100 : 100), max: 100 };
}

/** The selection, its hands and their colour scale, for a mode. */
function useStatsView(stats: StrategyStats, mode: StatsMode, potBb: number | null, dead: Set<string>) {
  const sel = useMemo(() => selection(stats, mode, potBb), [stats, mode, potBb]);
  const cells = useMemo(() => (sel ? handValues(sel, dead) : new Map<string, HandValue>()), [sel, dead]);
  const scale = useMemo(() => {
    const vs = [...cells.values()].map((c) => c.value);
    return scaleFor(mode, potBb, vs.length ? Math.min(...vs) : 0, vs.length ? Math.max(...vs) : 1);
  }, [cells, mode, potBb]);
  return { sel, cells, scale };
}

function colorOf(scale: Scale, v: number): string {
  return ramp(scale.stops, scale.at(v));
}

/** One stripe per combo, side by side, as hard-stop gradient. */
function stripesBackground(stripes: Stripe[], scale: Scale): string {
  if (stripes.length === 0) return "transparent";
  if (stripes.length === 1) return colorOf(scale, stripes[0].value);
  const total = stripes.reduce((s, x) => s + x.reach, 0);
  let x = 0;
  const parts: string[] = [];
  for (const s of stripes) {
    const from = (x / total) * 100;
    x += s.reach;
    const to = (x / total) * 100;
    const c = colorOf(scale, s.value);
    parts.push(`${c} ${from.toFixed(2)}%`, `${c} ${to.toFixed(2)}%`);
  }
  return `linear-gradient(to right, ${parts.join(", ")})`;
}

/* ---------- Text ---------- */

function pct(v: number, digits = 1): string {
  return `${v.toFixed(digits)}%`;
}

/** The short number printed in a cell. */
function cellText(mode: StatsMode, v: number): string {
  if (mode.kind === "ev") return fmtBb(v);
  return String(Math.round(v));
}

/** The full reading, for tooltips and the combo list. */
function longText(mode: StatsMode, v: number, potBb: number | null): string {
  if (mode.kind === "equity") return pct(v);
  if (mode.kind === "eqr") return `EqR ${pct(v, 0)}`;
  return potBb && potBb > 0 ? `${fmtBb(v)} bb · ${pct((v / potBb) * 100, 0)} pot` : `${fmtBb(v)} bb`;
}

/* ---------- Grid ---------- */

export function StatsGrid({
  stats,
  mode,
  dead,
  potBb = null,
  hovered,
  onHoverHand,
}: {
  stats: StrategyStats;
  mode: StatsMode;
  dead: Set<string>;
  /** Pot at the decision (bets in front included): EV is coloured by its share of it, EqR needs it. */
  potBb?: number | null;
  hovered?: string | null;
  onHoverHand?: (hand: string | null) => void;
}) {
  const { sel, cells, scale } = useStatsView(stats, mode, potBb, dead);

  if (!sel) {
    return (
      <p className="text-sm text-muted">
        {mode.kind === "eqr" ? "EqR needs the pot and the acting player's EV and equity." : "Not in this import."}
      </p>
    );
  }
  return (
    <div>
      <div
        className="grid select-none gap-0.5"
        style={{ gridTemplateColumns: `repeat(${RANKS.length}, minmax(0, 1fr))` }}
        onPointerLeave={() => onHoverHand?.(null)}
      >
        {GRID_HANDS.map((hand) => {
          const c = cells.get(hand);
          return (
            <div
              key={hand}
              title={c ? `${hand}: ${longText(mode, c.value, potBb)}` : hand}
              onPointerEnter={onHoverHand ? () => onHoverHand(hand) : undefined}
              className={[
                "relative flex aspect-square flex-col items-center justify-center overflow-hidden rounded-sm border leading-none",
                hovered === hand ? "border-accent ring-1 ring-accent" : c ? "border-black/15" : "border-line",
                c ? "text-black" : "bg-background text-muted/50",
              ].join(" ")}
              style={c ? { background: stripesBackground(c.stripes, scale) } : undefined}
            >
              <span className="text-[8px] font-semibold sm:text-[9px]">{hand}</span>
              {c && <span className="mt-px text-[8px] font-medium tabular-nums sm:text-[10px]">{cellText(mode, c.value)}</span>}
            </div>
          );
        })}
      </div>
      <Legend mode={mode} scale={scale} potBb={potBb} />
    </div>
  );
}

/** A thin bar of the scale under the grid, with where the colours switch. */
function Legend({ mode, scale, potBb }: { mode: StatsMode; scale: Scale; potBb: number | null }) {
  if (mode.kind === "ev" && !(potBb && potBb > 0)) {
    return <p className="mt-2 text-[11px] text-muted">No pot here: EV coloured from the worst hand to the best.</p>;
  }
  const { stops, max } = scale;
  const ticks =
    mode.kind === "equity"
      ? [0, 25, 50, 75, 100].map((v) => ({ at: v, label: `${v}%` }))
      : mode.kind === "eqr"
        ? [0, 50, 100, 150, 200].map((v) => ({ at: v, label: `${v}%` }))
        : [0, 50, 100, 150].map((v) => ({ at: v, label: v === 50 ? "½ pot" : v === 100 ? "pot" : `${v}%` }));
  // CSS interpolates linearly between stops like `ramp`, and two stops at the same place make the same hard switch.
  const gradient = stops.filter(([at]) => at <= max).map(([at, c]) => `${rgb(c)} ${((at / max) * 100).toFixed(2)}%`);
  return (
    <div className="mt-2 text-[10px] tabular-nums text-muted">
      <div className="h-1.5 rounded-full" style={{ background: `linear-gradient(to right, ${gradient.join(", ")})` }} />
      <div className="relative mt-0.5 h-3">
        {ticks.map((t, i) => (
          <span
            key={t.at}
            className={["absolute", i === 0 ? "" : i === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2"].join(" ")}
            style={{ left: `${(t.at / max) * 100}%` }}
          >
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Equity / EV / EqR of the whole range, for the legend. */
export function rangeTotal(stats: StrategyStats, mode: StatsMode, potBb: number | null = null): string | null {
  if (mode.kind === "equity") {
    const t = rangeEquity(stats, mode.player);
    return t == null ? null : `${t.toFixed(1)}%`;
  }
  const ev = stats.ev?.total;
  if (ev == null) return null;
  if (mode.kind === "ev") return `${fmtBb(ev)} bb`;
  const eq = rangeEquity(stats, stats.actor);
  if (!potBb || potBb <= 0 || eq == null || eq <= 0) return null;
  return `${Math.round(((ev / potBb) * 100) / (eq / 100))}%`;
}

function rangeEquity(stats: StrategyStats, player: "OOP" | "IP"): number | null {
  const p = stats.players[player];
  if (!p) return null;
  if (p.equityTotal != null) return p.equityTotal;
  // Older imports: the solver's total is missing, the per-combo equities aren't.
  let sum = 0;
  let w = 0;
  for (const [c, e] of Object.entries(p.equity)) {
    const r = p.range[c] ?? 0;
    if (r > 0 && e != null) {
      sum += e * r;
      w += r;
    }
  }
  return w > 0 ? sum / w : null;
}

/** The grid plus the hovered hand's combos. */
export function StatsDetail({
  stats,
  mode,
  dead,
  potBb = null,
}: {
  stats: StrategyStats;
  mode: StatsMode;
  dead: Set<string>;
  potBb?: number | null;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const { sel, scale } = useStatsView(stats, mode, potBb, dead);
  const combos = hovered ? handCombos(hovered).filter((c) => !comboBlocked(c, dead) && (sel?.range[c] ?? 0) > 0) : [];
  return (
    <div>
      <StatsGrid stats={stats} mode={mode} dead={dead} potBb={potBb} hovered={hovered} onHoverHand={setHovered} />
      <div className="mt-3 min-h-[15rem] border-t border-line pt-3 text-xs">
        {!hovered ? (
          <p className="text-muted">Hover a hand to see its combos.</p>
        ) : combos.length === 0 || !sel ? (
          <p className="text-muted">{hovered}: not in range here.</p>
        ) : (
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 tabular-nums">
            {combos.map((c) => (
              <ComboRow key={c} combo={c} sel={sel} mode={mode} scale={scale} potBb={potBb} stats={stats} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ComboRow({
  combo,
  sel,
  mode,
  scale,
  potBb,
  stats,
}: {
  combo: string;
  sel: Selection;
  mode: StatsMode;
  scale: Scale;
  potBb: number | null;
  stats: StrategyStats;
}) {
  const v = comboValue(sel, combo);
  const reach = sel.range[combo] ?? 0;
  // Bar length on the same axis as the legend.
  const width = v == null ? 0 : (scale.at(v) / scale.max) * 100;
  const eq = mode.kind === "eqr" ? stats.players[stats.actor]?.equity[combo] : null;
  const ev = mode.kind === "eqr" ? stats.ev?.node[combo] : null;
  return (
    <>
      <span className="font-medium">{combo}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-foreground/5">
        {v != null && (
          <span
            className="block h-full rounded-full"
            style={{ width: `${Math.min(100, Math.max(0, width))}%`, backgroundColor: colorOf(scale, v) }}
          />
        )}
      </span>
      <span className="text-right">
        {v == null ? "—" : longText(mode, v, potBb)}
        {mode.kind === "eqr" && ev != null && eq != null && potBb && (
          <span className="ml-2 text-muted">
            EV {pct((ev / potBb) * 100, 0)} / Eq {pct(eq)}
          </span>
        )}
        <span className="ml-2 text-muted">{Math.round(reach * 100)}% in range</span>
      </span>
    </>
  );
}
