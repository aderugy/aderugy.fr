"use client";

import { useEffect, useRef, useState } from "react";
import { fmtShortDay } from "./ui";
import { APP_TIMEZONE } from "@/lib/jobs/format";
import { fmtMoney } from "@/lib/live/types";

export type ChartPoint = {
  id: string;
  at: string;
  /** The session's result, and its all-in EV adjusted result, in money. */
  net: number;
  ev: number;
  /** The session's big blind, to count in bb. */
  bb: number;
};

type View = "session" | "month";
type Unit = "money" | "bb";

const H = 220;
const PAD = { top: 12, right: 12, bottom: 24, left: 52 };
// Result green, all-in EV dark yellow: one pair that passes the colour-blind
// and contrast checks on both the light and the dark surface.
const RESULT = { stroke: "stroke-[#237a36]", fill: "fill-[#237a36]" };
const EV = { stroke: "stroke-[#b08a0c]", fill: "fill-[#b08a0c]" };

/** "Nice" round step for about `n` ticks over `span`. */
function niceStep(span: number, n: number): number {
  const raw = span / Math.max(1, n);
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

const monthKey = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    timeZone: APP_TIMEZONE,
  })
    .format(new Date(iso))
    .slice(0, 7);
const monthLabel = (key: string, long = false) =>
  new Date(`${key}-15T12:00:00Z`).toLocaleDateString("en-GB", {
    month: long ? "long" : "short",
    year: long ? "numeric" : "2-digit",
    timeZone: "UTC",
  });

/** One bar pair or curve point: a session or a month. */
type Row = {
  key: string;
  label: string;
  net: number;
  ev: number;
  sessions: number;
};

/**
 * Result and all-in EV adjusted result, by session (cumulative curves) or by
 * month (one pair of bars a month), in money or in big blinds. One axis;
 * tap or hover for the numbers; a table underneath.
 */
export function ResultChart({
  points,
  currency,
  initialView = "session",
  initialUnit = "money",
}: {
  points: ChartPoint[];
  currency: string;
  initialView?: View;
  initialUnit?: Unit;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(340);
  const [hover, setHover] = useState<number | null>(null);
  const [view, setView] = useState<View>(initialView);
  const [unit, setUnit] = useState<Unit>(initialUnit);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setW(Math.max(260, Math.round(e.contentRect.width))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (points.length === 0) return null;

  const conv = (x: number, bb: number) => (unit === "bb" ? x / bb : x);
  const fmt = (x: number, signed = false) =>
    unit === "bb"
      ? `${signed && x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(Math.round(x * 10) / 10)} bb`
      : fmtMoney(Math.round(x), currency, signed);

  // Rows: sessions oldest first, or months.
  let rows: Row[];
  if (view === "session") {
    rows = points.map((p) => ({
      key: p.id,
      label: fmtShortDay(p.at),
      net: conv(p.net, p.bb),
      ev: conv(p.ev, p.bb),
      sessions: 1,
    }));
  } else {
    const byMonth = new Map<string, Row>();
    for (const p of points) {
      const k = monthKey(p.at);
      const r = byMonth.get(k) ?? {
        key: k,
        label: monthLabel(k),
        net: 0,
        ev: 0,
        sessions: 0,
      };
      r.net += conv(p.net, p.bb);
      r.ev += conv(p.ev, p.bb);
      r.sessions++;
      byMonth.set(k, r);
    }
    rows = [...byMonth.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  // Running totals from zero (the session curves, the table's totals).
  const cum: { net: number; ev: number }[] = [{ net: 0, ev: 0 }];
  for (const r of rows) {
    const last = cum[cum.length - 1];
    cum.push({ net: last.net + r.net, ev: last.ev + r.ev });
  }
  const values =
    view === "session"
      ? cum.flatMap((c) => [c.net, c.ev])
      : rows.flatMap((r) => [r.net, r.ev]);
  const step = niceStep(
    Math.max(0, ...values) - Math.min(0, ...values) ||
      (unit === "bb" ? 50 : 100),
    4,
  );
  const lo = Math.floor(Math.min(0, ...values) / step) * step;
  const hi = Math.ceil(Math.max(0, ...values) / step) * step || step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step)
    ticks.push(Math.round(v * 100) / 100);

  const iw = w - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + ih - ((v - lo) / (hi - lo)) * ih;

  // Session view: points 0..n on a line. Month view: one slot of bars a month.
  const xLine = (i: number) =>
    PAD.left + (cum.length === 1 ? 0 : (i / (cum.length - 1)) * iw);
  const slot = iw / Math.max(1, rows.length);
  const xSlot = (i: number) => PAD.left + slot * i + slot / 2;
  const barW = Math.max(3, Math.min(18, (slot - 8) / 2));
  const path = (key: "net" | "ev") =>
    cum
      .map(
        (c, i) =>
          `${i ? "L" : "M"}${xLine(i).toFixed(1)},${y(c[key]).toFixed(1)}`,
      )
      .join("");

  const pick = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const px = clientX - r.left - PAD.left;
    const i =
      view === "session"
        ? Math.round((px / iw) * (cum.length - 1)) - 1
        : Math.floor(px / slot);
    setHover(i >= 0 && i < rows.length ? i : null);
  };

  const total = cum[cum.length - 1];
  const hx =
    hover === null ? 0 : view === "session" ? xLine(hover + 1) : xSlot(hover);
  const tipLeft = Math.min(Math.max(hx - 90, 4), w - 184);
  const zero = y(0);

  // A bar rounded on its data end, square on the baseline.
  const bar = (x: number, v: number, cls: string) => {
    const end = y(v);
    const h = Math.abs(end - zero);
    if (h < 0.5)
      return (
        <line
          x1={x}
          x2={x + barW}
          y1={zero}
          y2={zero}
          strokeWidth={1.5}
          className={cls.replaceAll("fill-", "stroke-")}
        />
      );
    const r = Math.min(4, h, barW / 2);
    const s = v >= 0 ? 1 : -1;
    const d = `M${x},${zero} V${end + s * r} Q${x},${end} ${x + r},${end} H${x + barW - r} Q${x + barW},${end} ${x + barW},${end + s * r} V${zero} Z`;
    return <path d={d} className={cls} />;
  };

  return (
    <figure className="rounded-xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium">Result vs all-in EV</span>
        <div className="flex gap-1.5">
          <Toggle
            options={[
              ["session", "Sessions"],
              ["month", "Months"],
            ]}
            value={view}
            onChange={(v) => {
              setView(v as View);
              setHover(null);
            }}
          />
          <Toggle
            options={[
              ["money", currency],
              ["bb", "bb"],
            ]}
            value={unit}
            onChange={(v) => setUnit(v as Unit)}
          />
        </div>
      </div>
      <figcaption className="mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5 text-muted">
          <svg width="18" height="8" aria-hidden>
            {view === "session" ? (
              <line
                x1="1"
                y1="4"
                x2="17"
                y2="4"
                strokeWidth="2"
                strokeLinecap="round"
                className={RESULT.stroke}
              />
            ) : (
              <rect
                x="5"
                y="0"
                width="8"
                height="8"
                rx="2"
                className={RESULT.fill}
              />
            )}
          </svg>
          Result{" "}
          <span className="font-medium text-foreground tabular-nums">
            {fmt(total.net, true)}
          </span>
        </span>
        <span className="flex items-center gap-1.5 text-muted">
          <svg width="18" height="8" aria-hidden>
            {view === "session" ? (
              <line
                x1="1"
                y1="4"
                x2="17"
                y2="4"
                strokeWidth="2"
                strokeDasharray="4 3"
                className={EV.stroke}
              />
            ) : (
              <rect
                x="5"
                y="0"
                width="8"
                height="8"
                rx="2"
                className={EV.fill}
              />
            )}
          </svg>
          All-in EV adjusted{" "}
          <span className="font-medium text-foreground tabular-nums">
            {fmt(total.ev, true)}
          </span>
        </span>
      </figcaption>

      <div
        ref={box}
        className="relative mt-2 touch-pan-y select-none"
        onPointerMove={(e) => pick(e.clientX)}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerLeave={() => setHover(null)}
      >
        <svg
          viewBox={`0 0 ${w} ${H}`}
          className="block h-auto w-full"
          role="img"
          aria-label={`${view === "session" ? "Cumulative result by session" : "Result by month"}: ${fmt(total.net, true)}, all-in EV adjusted ${fmt(total.ev, true)}`}
        >
          {view === "month" && hover !== null && (
            <rect
              x={PAD.left + slot * hover}
              y={PAD.top}
              width={slot}
              height={ih}
              className="fill-muted/10"
            />
          )}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={w - PAD.right}
                y1={y(t)}
                y2={y(t)}
                className={t === 0 ? "stroke-muted/60" : "stroke-line"}
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted text-[10px] tabular-nums"
              >
                {fmt(t)}
              </text>
            </g>
          ))}

          {view === "session" ? (
            <>
              <text
                x={xLine(1)}
                y={H - 6}
                textAnchor="start"
                className="fill-muted text-[10px]"
              >
                {rows[0].label}
              </text>
              {rows.length > 1 && (
                <text
                  x={xLine(cum.length - 1)}
                  y={H - 6}
                  textAnchor="end"
                  className="fill-muted text-[10px]"
                >
                  {rows[rows.length - 1].label}
                </text>
              )}
              <path
                d={path("ev")}
                fill="none"
                strokeWidth={2}
                strokeDasharray="5 4"
                strokeLinejoin="round"
                className={EV.stroke}
              />
              <path
                d={path("net")}
                fill="none"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                className={RESULT.stroke}
              />
              {hover !== null && (
                <g>
                  <line
                    x1={hx}
                    x2={hx}
                    y1={PAD.top}
                    y2={PAD.top + ih}
                    className="stroke-muted/50"
                    strokeWidth={1}
                  />
                  <circle
                    cx={hx}
                    cy={y(cum[hover + 1].ev)}
                    r={4}
                    strokeWidth={2}
                    className={`${EV.fill} stroke-surface`}
                  />
                  <circle
                    cx={hx}
                    cy={y(cum[hover + 1].net)}
                    r={4}
                    strokeWidth={2}
                    className={`${RESULT.fill} stroke-surface`}
                  />
                </g>
              )}
            </>
          ) : (
            rows.map((r, i) => {
              const x0 = xSlot(i) - barW - 1;
              const every = Math.ceil(rows.length / 8);
              return (
                <g key={r.key}>
                  {bar(x0, r.net, RESULT.fill)}
                  {bar(x0 + barW + 2, r.ev, EV.fill)}
                  {i % every === 0 && (
                    <text
                      x={xSlot(i)}
                      y={H - 6}
                      textAnchor="middle"
                      className="fill-muted text-[10px]"
                    >
                      {r.label}
                    </text>
                  )}
                </g>
              );
            })
          )}
        </svg>

        {hover !== null && (
          <div
            className="pointer-events-none absolute top-0 w-44 rounded-lg border border-line bg-background/95 p-2 text-[11px] shadow-sm"
            style={{ left: tipLeft }}
          >
            <div className="font-medium">
              {view === "session"
                ? rows[hover].label
                : monthLabel(rows[hover].key, true)}
              {view === "month" && (
                <span className="font-normal text-muted">
                  {" "}
                  · {rows[hover].sessions} session
                  {rows[hover].sessions > 1 ? "s" : ""}
                </span>
              )}
            </div>
            <div className="mt-1 flex justify-between gap-2 text-muted">
              Result{" "}
              <span className="text-foreground tabular-nums">
                {fmt(rows[hover].net, true)}
              </span>
            </div>
            <div className="flex justify-between gap-2 text-muted">
              EV adj.{" "}
              <span className="text-foreground tabular-nums">
                {fmt(rows[hover].ev, true)}
              </span>
            </div>
            <div className="mt-1 flex justify-between gap-2 border-t border-line pt-1 text-muted">
              Total{" "}
              <span className="text-foreground tabular-nums">
                {fmt(cum[hover + 1].net, true)}
              </span>
            </div>
            <div className="flex justify-between gap-2 text-muted">
              Total EV adj.{" "}
              <span className="text-foreground tabular-nums">
                {fmt(cum[hover + 1].ev, true)}
              </span>
            </div>
          </div>
        )}
      </div>

      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-muted">As a table</summary>
        <table className="mt-1 w-full text-[11px] tabular-nums">
          <thead className="text-muted">
            <tr>
              <th className="py-0.5 text-left font-normal">
                {view === "session" ? "Session" : "Month"}
              </th>
              <th className="text-right font-normal">Result</th>
              <th className="text-right font-normal">EV adj.</th>
              <th className="text-right font-normal">Total</th>
              <th className="text-right font-normal">Total EV</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key} className="border-t border-line">
                <td className="py-0.5">
                  {view === "session" ? r.label : `${r.label} (${r.sessions})`}
                </td>
                <td className="text-right">{fmt(r.net, true)}</td>
                <td className="text-right">{fmt(r.ev, true)}</td>
                <td className="text-right">{fmt(cum[i + 1].net, true)}</td>
                <td className="text-right">{fmt(cum[i + 1].ev, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function Toggle({
  options,
  value,
  onChange,
}: {
  options: [string, string][];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-md border border-line text-[11px]">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`px-2 py-0.5 ${value === v ? "bg-foreground text-background" : "text-muted hover:text-foreground"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
