"use client";

import { useMemo, useRef, useState } from "react";
import { comboBlocked, comboToHand } from "@/lib/solver/cards";
import { fmtBb } from "@/lib/solver/gameState";
import type { PioPlayer } from "@/lib/solver/pio";
import type { StrategyStats } from "@/lib/solver/types";

/**
 * Pio's equity / EV graph: each player's combos sorted by value, the value
 * up the side and how much of the range is below it along the bottom (a combo
 * takes as much room as it is in range). Hover to read both curves at a point.
 */

type Kind = "equity" | "ev";
type Point = { x0: number; x1: number; v: number; combo: string };
type Curve = { player: PioPlayer; name: string; color: string; points: Point[]; avg: number | null };

const COLORS: Record<PioPlayer, string> = { OOP: "#2563eb", IP: "#e8590c" };

/** One player's combos in value order, spread over 0–100 by range weight. */
export function curvePoints(values: Record<string, number>, range: Record<string, number>, dead: Set<string>): Point[] {
  const list = Object.entries(values)
    .filter(([c, v]) => Number.isFinite(v) && (range[c] ?? 0) > 0 && !comboBlocked(c, dead))
    .map(([combo, v]) => ({ combo, v, w: range[combo] }))
    .sort((a, b) => a.v - b.v);
  const total = list.reduce((a, p) => a + p.w, 0);
  let acc = 0;
  return list.map((p) => {
    const x0 = (acc / total) * 100;
    acc += p.w;
    return { x0, x1: (acc / total) * 100, v: p.v, combo: p.combo };
  });
}

function valueAt(points: Point[], x: number): Point | null {
  if (points.length === 0) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].x1 < x) lo = mid + 1;
    else hi = mid;
  }
  return points[lo];
}

function niceTicks(lo: number, hi: number, count = 6): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(Math.round(t * 1000) / 1000);
  return out;
}

export function StatsGraph({
  stats,
  dead,
  seats,
}: {
  stats: StrategyStats;
  dead: Set<string>;
  seats: { OOP: string; IP: string };
}) {
  const [kind, setKind] = useState<Kind>("equity");
  const [hoverX, setHoverX] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const curves: Curve[] = useMemo(() => {
    const out: Curve[] = [];
    for (const p of ["OOP", "IP"] as PioPlayer[]) {
      const ps = stats.players[p];
      if (!ps) continue;
      const values = kind === "equity" ? ps.equity : (ps.ev ?? (p === stats.actor ? stats.ev?.node : undefined));
      if (!values || Object.keys(values).length === 0) continue;
      const points = curvePoints(values, ps.range, dead);
      if (points.length === 0) continue;
      const w = points.reduce((a, q) => a + (q.x1 - q.x0), 0);
      const avg = w > 0 ? points.reduce((a, q) => a + q.v * (q.x1 - q.x0), 0) / w : null;
      out.push({ player: p, name: seats[p], color: COLORS[p], points, avg });
    }
    return out;
  }, [stats, kind, dead, seats]);

  const missingEv = kind === "ev" && curves.length < 2 && !!stats.ev;
  const all = curves.flatMap((c) => c.points.map((q) => q.v));
  const [lo, hi] =
    kind === "equity" ? [0, 100] : all.length ? [Math.min(0, ...all), Math.max(...all)] : [0, 1];
  const ticks = kind === "equity" ? [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] : niceTicks(lo, hi);
  const yLo = kind === "equity" ? 0 : Math.min(lo, ticks[0] ?? lo);
  const yHi = kind === "equity" ? 100 : Math.max(hi, ticks[ticks.length - 1] ?? hi);

  // Plot box in viewBox units (4:3; x 0–100 → 10–130, y value → 92–4).
  const X = (x: number) => 10 + x * 1.2;
  const Y = (v: number) => 92 - ((v - yLo) / (yHi - yLo || 1)) * 88;
  const fmtV = (v: number) => (kind === "equity" ? `${v.toFixed(1)}%` : `${fmtBb(v)} bb`);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const vx = ((e.clientX - r.left) / r.width) * 133;
    const x = Math.min(100, Math.max(0, (vx - 10) / 1.2));
    setHoverX(x);
  }

  const hover = hoverX == null ? [] : curves.map((c) => ({ c, p: valueAt(c.points, hoverX) }));

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <div className="inline-flex rounded-md border border-line p-0.5">
          {(["equity", "ev"] as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={["rounded px-2 py-0.5", kind === k ? "bg-foreground/10 font-medium" : "text-muted hover:text-foreground"].join(" ")}
            >
              {k === "equity" ? "Equity" : "EV"}
            </button>
          ))}
        </div>
        {curves.map((c) => (
          <span key={c.player} className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded" style={{ backgroundColor: c.color }} />
            <b className="font-medium">{c.name}</b>
            <span className="tabular-nums text-muted">{c.avg == null ? "" : `avg ${fmtV(c.avg)}`}</span>
          </span>
        ))}
      </div>

      {curves.length === 0 ? (
        <p className="text-sm text-muted">Not in this import.</p>
      ) : (
        <svg
          ref={svgRef}
          viewBox="0 0 133 100"
          className="aspect-[4/3] w-full touch-none select-none rounded-md border border-line bg-surface"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHoverX(null)}
        >
          {/* Grid */}
          {ticks.map((t) => (
            <g key={`y${t}`}>
              <line x1={10} x2={130} y1={Y(t)} y2={Y(t)} stroke="currentColor" className="text-foreground/10" strokeWidth={0.2} vectorEffect="non-scaling-stroke" />
              <text x={8.5} y={Y(t)} textAnchor="end" dominantBaseline="middle" className="fill-muted" style={{ fontSize: 3.2 }}>
                {kind === "equity" ? t : fmtBb(t)}
              </text>
            </g>
          ))}
          {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((t) => (
            <g key={`x${t}`}>
              <line x1={X(t)} x2={X(t)} y1={4} y2={92} stroke="currentColor" className="text-foreground/10" strokeWidth={0.2} vectorEffect="non-scaling-stroke" />
              <text x={X(t)} y={96.5} textAnchor="middle" className="fill-muted" style={{ fontSize: 3.2 }}>
                {t}
              </text>
            </g>
          ))}
          {kind === "ev" && yLo < 0 && (
            <line x1={10} x2={130} y1={Y(0)} y2={Y(0)} stroke="currentColor" className="text-foreground/40" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
          )}
          {/* Curves */}
          {curves.map((c) => (
            <polyline
              key={c.player}
              fill="none"
              stroke={c.color}
              strokeWidth={2.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              points={c.points.map((q) => `${X((q.x0 + q.x1) / 2).toFixed(2)},${Y(q.v).toFixed(2)}`).join(" ")}
            />
          ))}
          {hoverX != null && (
            <line x1={X(hoverX)} x2={X(hoverX)} y1={4} y2={92} stroke="currentColor" className="text-foreground/50" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          )}
        </svg>
      )}

      <div className="mt-2 min-h-[2.75rem] text-xs tabular-nums">
        {hoverX == null ? (
          <p className="text-muted">
            Combos sorted by {kind === "equity" ? "equity" : "EV"}; along the bottom, the % of the range below. Hover to read it.
          </p>
        ) : (
          <div className="space-y-0.5">
            <p className="text-muted">{hoverX.toFixed(0)}% of the range</p>
            {hover.map(({ c, p }) =>
              p ? (
                <p key={c.player}>
                  <span className="mr-1.5 inline-block size-2 rounded-full" style={{ backgroundColor: c.color }} />
                  {c.name} <b className="font-medium">{fmtV(p.v)}</b>{" "}
                  <span className="text-muted">
                    {p.combo} ({comboToHand(p.combo)})
                  </span>
                </p>
              ) : null,
            )}
          </div>
        )}
      </div>
      {missingEv && (
        <p className="mt-1 text-[11px] text-muted">Only the player to act has EV in this import: import it again from Pio for both.</p>
      )}
    </div>
  );
}
