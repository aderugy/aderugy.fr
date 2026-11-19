"use client";

import { useState } from "react";
import { GRID_HANDS } from "@/lib/solver/cards";
import { AUTO_CATEGORIES, parseAutoNote, rangeShare, type ParsedRange } from "@/lib/hud/ranges";
import type { Pt4AutoNote } from "@/lib/hud/types";

/**
 * PT4's auto-generated notes of a player, read-only: grouped by street, most
 * frequent first, ranges in short form; hovering a range shows it on the
 * 13×13 grid.
 */
export function AutoNotes({ notes }: { notes: Pt4AutoNote[] }) {
  const [tip, setTip] = useState<{ range: ParsedRange; raw: string; x: number; y: number } | null>(null);
  if (!notes.length) return null;
  const groups = new Map<number, Pt4AutoNote[]>();
  for (const n of notes) groups.set(n.category, [...(groups.get(n.category) ?? []), n]);

  return (
    <div className="mt-1.5 border-t border-neutral-800 pt-1.5 font-sans text-[11px] leading-[18px]">
      <div className="max-h-56 overflow-y-auto pr-1 [scrollbar-width:thin]">
        {[...groups.entries()]
          .sort(([a], [b]) => a - b)
          .map(([cat, list]) => (
            <div key={cat} className="mb-1">
              <div className="text-[10px] uppercase tracking-wide text-neutral-500">
                {AUTO_CATEGORIES[cat] ?? `Category ${cat}`}
              </div>
              {list.map((n, i) => (
                <div key={i} className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 text-neutral-300">
                    {parseAutoNote(n.text).map((seg, j) =>
                      seg.t === "text" ? (
                        <span key={j}>{seg.text}</span>
                      ) : (
                        <span
                          key={j}
                          onMouseEnter={(e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            setTip({
                              range: seg.range,
                              raw: seg.raw,
                              x: Math.max(4, Math.min(r.left, window.innerWidth - 228)),
                              y: r.bottom + 4 + 236 > window.innerHeight ? r.top - 240 : r.bottom + 4,
                            });
                          }}
                          onMouseLeave={() => setTip(null)}
                          className="cursor-default rounded bg-neutral-800 px-1 font-mono text-sky-300"
                        >
                          {seg.raw.replaceAll(",", ", ")}
                        </span>
                      ),
                    )}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-neutral-500" title={`${n.count} times`}>
                    ×{n.count}
                  </span>
                </div>
              ))}
            </div>
          ))}
      </div>
      {tip && <RangeGrid range={tip.range} raw={tip.raw} x={tip.x} y={tip.y} />}
    </div>
  );
}

/** A range on the 13×13 grid (fixed position: the note card clips overflow). */
function RangeGrid({ range, raw, x, y }: { range: ParsedRange; raw: string; x: number; y: number }) {
  return (
    <div
      role="tooltip"
      style={{ left: x, top: y }}
      className="pointer-events-none fixed z-50 rounded-md border border-neutral-700 bg-neutral-900 p-1.5 shadow-xl"
    >
      <div className="grid gap-px" style={{ gridTemplateColumns: "repeat(13, 1rem)" }}>
        {GRID_HANDS.map((h) => (
          <div
            key={h}
            className={[
              "flex h-4 items-center justify-center rounded-[2px] font-mono text-[7px] leading-none",
              range.hands.has(h) ? "bg-sky-500 text-white" : "bg-neutral-800 text-neutral-500",
            ].join(" ")}
          >
            {h.slice(0, 2)}
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-sans text-[10px] text-neutral-400">
        <span>
          {range.hands.size} hands · {(rangeShare(range.hands) * 100).toFixed(1)} %
        </span>
        {range.unknown.length > 0 && <span title={raw}>not read: {range.unknown.join(", ")}</span>}
      </div>
    </div>
  );
}
