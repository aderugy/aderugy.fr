"use client";

import { showStat } from "@/lib/hud/format";
import type { HudGroup, HudItem, PlayerHud } from "@/lib/hud/types";

type Row = { kind: "row"; items: HudItem[] } | { kind: "hr" };

/** Splits a PT4 stat group into rows: "New Line" breaks, "Horizontal Line" divides. */
function rows(items: HudItem[]): Row[] {
  const out: Row[] = [];
  let cur: HudItem[] = [];
  const flush = () => {
    if (cur.length) out.push({ kind: "row", items: cur });
    cur = [];
  };
  for (const it of items) {
    if (it.t === "br") flush();
    else if (it.t === "hr") {
      flush();
      out.push({ kind: "hr" });
    } else cur.push(it);
  }
  flush();
  return out;
}

/**
 * One stat group of the PT4 layout, drawn like PT4 does: on black, with the
 * layout's colour ranges. `compact` is the main line; otherwise a popup, where
 * rows are grids (a label, then one cell per position).
 */
export function HudPanel({
  group,
  hud,
  compact = false,
  onPopup,
}: {
  group: HudGroup;
  hud: PlayerHud | undefined;
  compact?: boolean;
  onPopup?: (name: string) => void;
}) {
  return (
    <div
      className={[
        "rounded-lg bg-neutral-950 font-mono tabular-nums text-neutral-100",
        compact ? "px-3 py-2 text-[15px] leading-7" : "overflow-x-auto px-3 py-2 text-xs leading-6",
      ].join(" ")}
    >
      {rows(group.items).map((r, i) =>
        r.kind === "hr" ? (
          <div key={i} className="my-1 border-t border-neutral-700" />
        ) : (
          <div key={i} className={compact ? "flex flex-wrap items-baseline gap-x-3" : "flex items-baseline"}>
            {r.items.map((it, j) => (
              <Cell key={j} item={it} hud={hud} compact={compact} first={j === 0} onPopup={onPopup} />
            ))}
          </div>
        ),
      )}
    </div>
  );
}

function Cell({
  item,
  hud,
  compact,
  first,
  onPopup,
}: {
  item: HudItem;
  hud: PlayerHud | undefined;
  compact: boolean;
  first: boolean;
  onPopup?: (name: string) => void;
}) {
  if (item.t === "text") {
    // In popups, the first text of a row is its label; short texts after it
    // are column headers (EP, MP…) and line up with the stat cells.
    const width = compact
      ? ""
      : first
        ? "w-48 shrink-0 truncate pr-2 text-left"
        : item.text.trim().length <= 6
          ? "w-12 shrink-0 text-center"
          : "shrink-0 whitespace-nowrap px-2 text-left";
    return (
      <span className={`${width} text-neutral-400`} title={item.text}>
        {item.text.trim()}
      </span>
    );
  }
  if (item.t !== "stat") return null;
  const s = showStat(item, hud?.stats, hud?.name);
  const width = compact ? "" : "w-12 shrink-0 text-center";
  const body = (
    <>
      {item.prefix && <span className="text-neutral-500">{item.prefix.trim()} </span>}
      <span style={{ color: s.color }} className={s.thin ? "opacity-50" : undefined}>
        {s.text}
      </span>
    </>
  );
  if (item.popup && onPopup) {
    return (
      <button
        type="button"
        title={`${s.title} — open ${item.popup}`}
        onClick={() => onPopup(item.popup!)}
        className={`${width} rounded underline decoration-neutral-700 underline-offset-4 hover:decoration-neutral-300`}
      >
        {body}
      </button>
    );
  }
  return (
    <span className={width} title={s.title}>
      {body}
    </span>
  );
}
