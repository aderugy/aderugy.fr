"use client";

import { useMemo, useState } from "react";
import { gridCells, showStat, type GridCell, type ShownStat } from "@/lib/hud/format";
import type { HudGroup, HudItem, PlayerHud } from "@/lib/hud/types";

/** The hovered stat and where to draw its card (viewport coordinates). */
type Tip = { s: ShownStat; x: number; y: number };
type OnHover = (s: ShownStat | null, el?: HTMLElement) => void;

/**
 * One stat group of the PT4 layout, drawn like PT4 does: on black, with the
 * layout's colour ranges. `compact` is the main line; otherwise a popup, where
 * rows are grids (a label, then one cell per position). Hovering a stat shows
 * its name, value and occurrences / opportunities right away.
 */
export function HudPanel({
  group,
  hud,
  compact = false,
  dense = false,
  onPopup,
}: {
  group: HudGroup;
  hud: PlayerHud | undefined;
  compact?: boolean;
  /** A small grid panel for the HUD row (narrow columns, small type). */
  dense?: boolean;
  onPopup?: (name: string) => void;
}) {
  const [tip, setTip] = useState<Tip | null>(null);
  const { cells, columns } = useMemo(() => gridCells(group.items), [group.items]);
  const onHover: OnHover = (s, el) => {
    if (!s || !el) return setTip(null);
    const r = el.getBoundingClientRect();
    // Fixed position: popups scroll horizontally and would clip an absolute card.
    setTip({ s, x: Math.max(4, Math.min(r.left, window.innerWidth - 244)), y: r.bottom + 6 });
  };

  return (
    <div
      onMouseLeave={() => setTip(null)}
      className={[
        "rounded-lg border border-line bg-inset font-mono tabular-nums text-foreground",
        compact
          ? "px-3 py-2 text-[15px] leading-7"
          : dense
            ? "overflow-x-auto px-2.5 py-1.5 text-[11px] leading-5"
            : "overflow-x-auto px-3 py-2 text-xs leading-6",
      ].join(" ")}
    >
      {compact ? (
        // Panels at the table (main line, Avancé): one flowing line per row.
        rowsOf(cells).map((r, i) =>
          r === "hr" ? (
            <div key={i} className="my-1 border-t border-line" />
          ) : (
            <div key={i} className="flex flex-wrap items-baseline gap-x-3">
              {r.map((c, j) => (
                <Cell key={j} item={c.item} hud={hud} onPopup={onPopup} onHover={onHover} />
              ))}
            </div>
          ),
        )
      ) : (
        // Popups: PT4's grid, cells spanning their columns.
        <div
          className={dense ? "grid items-baseline gap-x-1.5" : "grid items-baseline gap-x-2"}
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(${dense ? "1.75rem" : "2.75rem"}, max-content))` }}
        >
          {cells.map((c, i) =>
            c.kind === "hr" ? (
              <div key={i} style={{ gridRow: c.row, gridColumn: "1 / -1" }} className="my-1 border-t border-line" />
            ) : (
              <div
                key={i}
                style={{ gridRow: c.row, gridColumn: `${c.col} / span ${c.span}` }}
                className={`min-w-0 whitespace-nowrap ${align(c)}`}
              >
                <Cell item={c.item} hud={hud} onPopup={onPopup} onHover={onHover} />
              </div>
            ),
          )}
        </div>
      )}
      {tip && (
        <div
          role="tooltip"
          style={{ left: tip.x, top: tip.y }}
          className="pointer-events-none fixed z-50 w-max max-w-60 rounded-md border border-line bg-surface px-2.5 py-1.5 font-sans text-xs leading-5 text-foreground shadow-lg"
        >
          <div className="font-medium">{tip.s.label}</div>
          <div className="font-mono tabular-nums">
            <span style={tip.s.color ? ({ "--hud-c": tip.s.color } as React.CSSProperties) : undefined} className={tip.s.color ? "hud-c font-semibold" : undefined}>
              {tip.s.text}
            </span>
            {tip.s.sample && <span className="text-muted"> · {tip.s.sample}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

type Placed = Extract<GridCell, { kind: "cell" }>;

/** Cells grouped by row, for the flowing panels ("hr" = divider). */
function rowsOf(cells: GridCell[]): (Placed[] | "hr")[] {
  const out: (Placed[] | "hr")[] = [];
  let row = -1;
  for (const c of cells) {
    if (c.kind === "hr") {
      out.push("hr");
      row = -1;
    } else if (c.row !== row) {
      out.push([c]);
      row = c.row;
    } else (out[out.length - 1] as Placed[]).push(c);
  }
  return out;
}

/**
 * Popup alignment: PT4's when it sets one; values and short headers (EP, MP,
 * Total…) centred so they line up; labels left.
 */
function align(c: Placed): string {
  if (c.item.align === "center") return "text-center";
  if (c.item.align === "right") return "text-right";
  if (c.item.t === "stat") return "text-center";
  return c.col > 1 && c.span === 1 && c.item.text.trim().length <= 6 ? "text-center" : "text-left";
}

function Cell({
  item,
  hud,
  onPopup,
  onHover,
}: {
  item: Exclude<HudItem, { t: "br" } | { t: "hr" }>;
  hud: PlayerHud | undefined;
  onPopup?: (name: string) => void;
  onHover: OnHover;
}) {
  if (item.t === "text") {
    return (
      <span className="text-muted" title={item.text}>
        {item.text.trim()}
      </span>
    );
  }
  const s = showStat(item, hud?.stats, hud?.name);
  const hover = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => onHover(s, e.currentTarget),
    onMouseLeave: () => onHover(null),
  };
  const body = (
    <>
      {item.prefix && <span className="text-muted">{item.prefix.trim()} </span>}
      {/* PT4's colour, clamped for the theme (globals.css .hud-c). */}
      <span
        style={s.color ? ({ "--hud-c": s.color } as React.CSSProperties) : undefined}
        className={[s.color ? "hud-c font-semibold" : "", s.thin ? "opacity-50" : ""].join(" ").trim() || undefined}
      >
        {s.text}
      </span>
    </>
  );
  if (item.popup && onPopup) {
    return (
      <button
        type="button"
        aria-label={`${s.title} — open ${item.popup}`}
        onClick={() => onPopup(item.popup!)}
        {...hover}
        className="rounded underline decoration-line underline-offset-4 hover:decoration-foreground"
      >
        {body}
      </button>
    );
  }
  return (
    <span className="cursor-default rounded hover:bg-line/60" aria-label={s.title} {...hover}>
      {body}
    </span>
  );
}
