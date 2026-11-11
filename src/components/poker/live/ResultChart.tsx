"use client";

import { useEffect, useRef, useState } from "react";
import { fmtShortDay } from "./ui";
import { fmtMoney } from "@/lib/live/types";

export type ChartPoint = {
  id: string;
  at: string;
  /** The session's own result, and its all-in EV adjusted result. */
  net: number;
  ev: number;
};

const H = 220;
const PAD = { top: 12, right: 12, bottom: 24, left: 52 };

/** "Nice" round step for about `n` ticks over `span`. */
function niceStep(span: number, n: number): number {
  const raw = span / Math.max(1, n);
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

/**
 * Cumulative result and cumulative all-in EV adjusted result, one point per
 * finished session, oldest first. One axis, one currency; tap or hover for a
 * session's numbers.
 */
export function ResultChart({ points, currency }: { points: ChartPoint[]; currency: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(340);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (points.length === 0) return null;

  // Running totals, with a zero before the first session.
  const cum: { net: number; ev: number }[] = [{ net: 0, ev: 0 }];
  for (const p of points) {
    const last = cum[cum.length - 1];
    cum.push({ net: last.net + p.net, ev: last.ev + p.ev });
  }
  const all = cum.flatMap((c) => [c.net, c.ev]);
  const step = niceStep(Math.max(...all) - Math.min(...all, 0) || 100, 4);
  const lo = Math.floor(Math.min(0, ...all) / step) * step;
  const hi = Math.ceil(Math.max(0, ...all) / step) * step || step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);

  const iw = w - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (cum.length === 1 ? 0 : (i / (cum.length - 1)) * iw);
  const y = (v: number) => PAD.top + ih - ((v - lo) / (hi - lo)) * ih;
  const path = (key: "net" | "ev") => cum.map((c, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(c[key]).toFixed(1)}`).join("");

  const pick = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const i = Math.round(((clientX - r.left - PAD.left) / iw) * (cum.length - 1));
    setHover(i >= 1 && i < cum.length ? i : null);
  };

  const end = cum[cum.length - 1];
  const h = hover !== null ? { p: points[hover - 1], c: cum[hover] } : null;
  const tipLeft = hover !== null ? Math.min(Math.max(x(hover) - 90, 4), w - 184) : 0;

  return (
    <figure className="rounded-xl border border-line bg-surface p-3">
      <figcaption className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
        <span className="font-medium">Result vs all-in EV</span>
        <span className="flex items-center gap-1.5 text-muted">
          <svg width="18" height="8" aria-hidden>
            <line x1="1" y1="4" x2="17" y2="4" strokeWidth="2" strokeLinecap="round" className="stroke-[#3b5bdb] dark:stroke-[#3987e5]" />
          </svg>
          Result <span className="font-medium text-foreground tabular-nums">{fmtMoney(Math.round(end.net), currency, true)}</span>
        </span>
        <span className="flex items-center gap-1.5 text-muted">
          <svg width="18" height="8" aria-hidden>
            <line x1="1" y1="4" x2="17" y2="4" strokeWidth="2" strokeDasharray="4 3" className="stroke-[#eb6834] dark:stroke-[#d95926]" />
          </svg>
          All-in EV adjusted <span className="font-medium text-foreground tabular-nums">{fmtMoney(Math.round(end.ev), currency, true)}</span>
        </span>
      </figcaption>

      <div
        ref={box}
        className="relative mt-2 touch-pan-y select-none"
        onPointerMove={(e) => pick(e.clientX)}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${w} ${H}`} className="block h-auto w-full" role="img" aria-label={`Cumulative result ${fmtMoney(Math.round(end.net), currency, true)}, all-in EV adjusted ${fmtMoney(Math.round(end.ev), currency, true)}, over ${points.length} sessions`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={w - PAD.right} y1={y(t)} y2={y(t)} className={t === 0 ? "stroke-muted/60" : "stroke-line"} strokeWidth={1} />
              <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[10px] tabular-nums">
                {fmtMoney(t, currency)}
              </text>
            </g>
          ))}
          <text x={x(1)} y={H - 6} textAnchor="start" className="fill-muted text-[10px]">
            {fmtShortDay(points[0].at)}
          </text>
          {points.length > 1 && (
            <text x={x(cum.length - 1)} y={H - 6} textAnchor="end" className="fill-muted text-[10px]">
              {fmtShortDay(points[points.length - 1].at)}
            </text>
          )}
          <path d={path("ev")} fill="none" strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" className="stroke-[#eb6834] dark:stroke-[#d95926]" />
          <path d={path("net")} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="stroke-[#3b5bdb] dark:stroke-[#3987e5]" />
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih} className="stroke-muted/50" strokeWidth={1} />
              <circle cx={x(hover)} cy={y(cum[hover].ev)} r={4} strokeWidth={2} className="fill-[#eb6834] stroke-surface dark:fill-[#d95926]" />
              <circle cx={x(hover)} cy={y(cum[hover].net)} r={4} strokeWidth={2} className="fill-[#3b5bdb] stroke-surface dark:fill-[#3987e5]" />
            </g>
          )}
        </svg>
        {h && (
          <div
            className="pointer-events-none absolute top-0 w-44 rounded-lg border border-line bg-background/95 p-2 text-[11px] shadow-sm"
            style={{ left: tipLeft }}
          >
            <div className="font-medium">{fmtShortDay(h.p.at)}</div>
            <div className="mt-1 flex justify-between gap-2 text-muted">
              Session <span className="text-foreground tabular-nums">{fmtMoney(h.p.net, currency, true)}</span>
            </div>
            <div className="flex justify-between gap-2 text-muted">
              Session EV adj. <span className="text-foreground tabular-nums">{fmtMoney(h.p.ev, currency, true)}</span>
            </div>
            <div className="mt-1 flex justify-between gap-2 border-t border-line pt-1 text-muted">
              Total <span className="text-foreground tabular-nums">{fmtMoney(Math.round(h.c.net), currency, true)}</span>
            </div>
            <div className="flex justify-between gap-2 text-muted">
              Total EV adj. <span className="text-foreground tabular-nums">{fmtMoney(Math.round(h.c.ev), currency, true)}</span>
            </div>
          </div>
        )}
      </div>

      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-muted">As a table</summary>
        <table className="mt-1 w-full text-[11px] tabular-nums">
          <thead className="text-muted">
            <tr>
              <th className="py-0.5 text-left font-normal">Session</th>
              <th className="text-right font-normal">Result</th>
              <th className="text-right font-normal">EV adj.</th>
              <th className="text-right font-normal">Total</th>
              <th className="text-right font-normal">Total EV</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr key={p.id} className="border-t border-line">
                <td className="py-0.5">{fmtShortDay(p.at)}</td>
                <td className="text-right">{fmtMoney(Math.round(p.net), currency, true)}</td>
                <td className="text-right">{fmtMoney(Math.round(p.ev), currency, true)}</td>
                <td className="text-right">{fmtMoney(Math.round(cum[i + 1].net), currency, true)}</td>
                <td className="text-right">{fmtMoney(Math.round(cum[i + 1].ev), currency, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
