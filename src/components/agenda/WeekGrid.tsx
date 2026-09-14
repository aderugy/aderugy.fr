"use client";

import { useRef, useState } from "react";
import {
  DAY_END_MIN,
  DAY_LABELS,
  DAY_START_MIN,
  PX_PER_SLOT,
  SLOTS_PER_DAY,
  SLOT_MIN,
  addDays,
  clamp,
  dateAt,
  dayIndexOf,
  fmtDuration,
  fmtTime,
  minutesOfDay,
  slotToY,
  yToMinutes,
} from "@/lib/time";
import type { AllDayItem, DragPayload, GridItem } from "@/lib/types";
import { mergeSpans } from "@/lib/external";

/** Soft cap per day. Planned and committed time are measured against it together. */
export const DAILY_CAPACITY_MIN = 10 * 60;

const GRID_HEIGHT = SLOTS_PER_DAY * PX_PER_SLOT;

type Span = { id: string; start: number; end: number };

/**
 * Greedy lane assignment so overlapping items sit side by side instead of on
 * top of each other. Items are grouped into clusters of mutual overlap; every
 * item in a cluster shares the same lane count, which keeps widths stable.
 */
function layoutLanes(spans: Span[]) {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = new Map<string, { lane: number; lanes: number }>();

  let cluster: Span[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    const laneEnds: number[] = [];
    const assigned: { id: string; lane: number }[] = [];

    for (const s of cluster) {
      let lane = laneEnds.findIndex((end) => end <= s.start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(s.end);
      } else {
        laneEnds[lane] = s.end;
      }
      assigned.push({ id: s.id, lane });
    }
    for (const a of assigned) {
      out.set(a.id, { lane: a.lane, lanes: laneEnds.length });
    }
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const s of sorted) {
    if (cluster.length > 0 && s.start >= clusterEnd) flush();
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, s.end);
  }
  flush();

  return out;
}

/**
 * A block with tasks in it gives its own text to the tooltip: the children take
 * the space inside, and what the block itself is called would otherwise have
 * nowhere to show.
 */
function itemTitle(item: GridItem, startMin: number, endMin: number) {
  const when = `${fmtTime(startMin)}–${fmtTime(endMin)}`;
  const parts = [item.label, item.description].filter(
    (p): p is string => Boolean(p) && p !== "",
  );
  const head = [...new Set(parts)].join(" — ");
  const kept = item.archived
    ? "\nArchived — your calendar deleted this once it was over. Kept here."
    : "";

  if (item.children.length === 0) {
    return `${head ? `${head} · ${when}` : when}${kept}`;
  }

  const inside = item.children
    .map((c) => `${c.label} ${fmtDuration(c.minutes)}`)
    .join(", ");
  return `${head ? `${head} · ` : ""}${when}\n${inside}${kept}`;
}

export type DrawnRange = {
  startsAt: Date;
  endsAt: Date;
  /** True when the drawn span lands on time a calendar has already committed. */
  overCommitted: boolean;
  anchor: { top: number; bottom: number; left: number; right: number };
};

type DragState = {
  id: string;
  mode: "move" | "resize";
  dayIndex: number;
  startMin: number;
  endMin: number;
  grabY: number;
  moved: boolean;
};

type Props = {
  weekStartDate: Date;
  /** Own blocks and external events, already normalised and merged. */
  items: GridItem[];
  allDay: AllDayItem[];
  selectedId: string | null;
  pendingDrag: DragPayload | null;
  onSelect: (id: string | null) => void;
  onCreateFromDrag: (payload: DragPayload, startsAt: Date) => void;
  onDraw: (range: DrawnRange) => void;
  onMove: (id: string, startsAt: Date, endsAt: Date) => void;
};

export function WeekGrid({
  weekStartDate,
  items,
  allDay,
  selectedId,
  pendingDrag,
  onSelect,
  onCreateFromDrag,
  onDraw,
  onMove,
}: Props) {
  const colsRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hover, setHover] = useState<{ dayIndex: number; startMin: number } | null>(
    null,
  );
  // A drawn range lives only in the UI until the popup is submitted: an
  // abandoned drag must never leave a row behind.
  const [draw, setDraw] = useState<{
    dayIndex: number;
    anchorMin: number;
    currentMin: number;
    moved: boolean;
  } | null>(null);

  const today = new Date();

  /** Where an item sits right now — mid-drag values win over stored ones. */
  const positionOf = (item: GridItem) => {
    if (drag && drag.id === item.id) {
      return { dayIndex: drag.dayIndex, startMin: drag.startMin, endMin: drag.endMin };
    }
    const start = new Date(item.startsAt);
    const end = new Date(item.endsAt);
    return {
      dayIndex: dayIndexOf(weekStartDate, start),
      startMin: minutesOfDay(start),
      endMin:
        minutesOfDay(start) + Math.round((end.getTime() - start.getTime()) / 60_000),
    };
  };

  const byDay: GridItem[][] = Array.from({ length: 7 }, () => []);
  for (const item of items) {
    const { dayIndex } = positionOf(item);
    if (dayIndex >= 0) byDay[dayIndex].push(item);
  }

  // Planned and committed are reported separately but measured against one
  // capacity: an hour of lecture is an hour you cannot also plan into.
  const dayTotals = byDay.map((list) => {
    let planned = 0;
    const committedSpans: { startMin: number; endMin: number }[] = [];

    for (const item of list) {
      const { startMin, endMin } = positionOf(item);
      if (item.kind === "external") committedSpans.push({ startMin, endMin });
      else planned += endMin - startMin;
    }

    const committed = mergeSpans(committedSpans).reduce(
      (sum, s) => sum + (s.endMin - s.startMin),
      0,
    );
    return { planned, committed };
  });

  function overlapsCommitted(dayIndex: number, startMin: number, endMin: number) {
    return byDay[dayIndex]
      .filter((i) => i.kind === "external")
      .some((i) => {
        const pos = positionOf(i);
        return pos.startMin < endMin && startMin < pos.endMin;
      });
  }

  /** Selection bounds, normalised so dragging upward works. */
  const drawnRange = draw
    ? {
        startMin: Math.min(draw.anchorMin, draw.currentMin),
        endMin: Math.max(draw.anchorMin, draw.currentMin),
      }
    : null;

  function slotFromPointer(clientX: number, clientY: number) {
    const rect = colsRef.current!.getBoundingClientRect();
    const colWidth = rect.width / 7;
    const dayIndex = clamp(Math.floor((clientX - rect.left) / colWidth), 0, 6);
    const startMin = clamp(
      yToMinutes(clientY - rect.top),
      DAY_START_MIN,
      DAY_END_MIN - SLOT_MIN,
    );
    return { dayIndex, startMin };
  }

  function onColumnPointerDown(e: React.PointerEvent<HTMLDivElement>, dayIndex: number) {
    // Items are children of this column. Without this guard, grabbing one would
    // also start a selection underneath it.
    if (e.target !== e.currentTarget) return;
    if (e.button !== 0) return;

    e.currentTarget.setPointerCapture(e.pointerId);
    const { startMin } = slotFromPointer(e.clientX, e.clientY);
    setDraw({
      dayIndex,
      anchorMin: startMin,
      currentMin: startMin + SLOT_MIN,
      moved: false,
    });
  }

  function onColumnPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draw) return;
    const rect = colsRef.current!.getBoundingClientRect();
    const currentMin = clamp(
      yToMinutes(e.clientY - rect.top),
      DAY_START_MIN,
      DAY_END_MIN,
    );
    if (currentMin === draw.currentMin) return;
    setDraw({ ...draw, currentMin, moved: true });
  }

  function onColumnPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!draw || !drawnRange) return;
    e.currentTarget.releasePointerCapture(e.pointerId);

    const span = drawnRange.endMin - drawnRange.startMin;
    const current = draw;
    setDraw(null);

    // A stationary press is a click, not a zero-length event.
    if (!current.moved || span < SLOT_MIN) {
      onSelect(null);
      return;
    }
    openDraw(current.dayIndex, drawnRange.startMin, drawnRange.endMin);
  }

  /** Hand the drawn range up with viewport coordinates so the popup can anchor. */
  function openDraw(dayIndex: number, startMin: number, endMin: number) {
    const rect = colsRef.current!.getBoundingClientRect();
    const colWidth = rect.width / 7;

    onDraw({
      startsAt: dateAt(weekStartDate, dayIndex, startMin),
      endsAt: dateAt(weekStartDate, dayIndex, endMin),
      overCommitted: overlapsCommitted(dayIndex, startMin, endMin),
      anchor: {
        top: rect.top + slotToY(startMin),
        bottom: rect.top + slotToY(endMin),
        left: rect.left + dayIndex * colWidth,
        right: rect.left + (dayIndex + 1) * colWidth,
      },
    });
  }

  function onItemPointerDown(e: React.PointerEvent<HTMLDivElement>, item: GridItem) {
    if (e.button !== 0) return;
    e.stopPropagation();

    // Read-only items still select — you can look at one — but never move.
    if (!item.movable) {
      e.preventDefault();
      onSelect(item.id === selectedId ? null : item.id);
      return;
    }

    const target = e.target as HTMLElement;
    const mode: "move" | "resize" = target.dataset.resize === "true" ? "resize" : "move";

    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);

    const rect = colsRef.current!.getBoundingClientRect();
    const { dayIndex, startMin, endMin } = positionOf(item);
    const itemTop = rect.top + slotToY(startMin);

    setDrag({
      id: item.id,
      mode,
      dayIndex,
      startMin,
      endMin,
      grabY: e.clientY - itemTop,
      moved: false,
    });
  }

  function onItemPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const rect = colsRef.current!.getBoundingClientRect();
    const colWidth = rect.width / 7;
    const duration = drag.endMin - drag.startMin;

    if (drag.mode === "move") {
      const dayIndex = clamp(Math.floor((e.clientX - rect.left) / colWidth), 0, 6);
      const startMin = clamp(
        yToMinutes(e.clientY - rect.top - drag.grabY),
        DAY_START_MIN,
        DAY_END_MIN - duration,
      );
      if (dayIndex === drag.dayIndex && startMin === drag.startMin && !drag.moved) return;
      setDrag({ ...drag, dayIndex, startMin, endMin: startMin + duration, moved: true });
    } else {
      const endMin = clamp(
        yToMinutes(e.clientY - rect.top),
        drag.startMin + SLOT_MIN,
        DAY_END_MIN,
      );
      if (endMin === drag.endMin && !drag.moved) return;
      setDrag({ ...drag, endMin, moved: true });
    }
  }

  function onItemPointerUp(e: React.PointerEvent<HTMLDivElement>, item: GridItem) {
    if (!drag || drag.id !== item.id) return;
    e.currentTarget.releasePointerCapture(e.pointerId);

    if (!drag.moved) {
      onSelect(item.id === selectedId ? null : item.id);
    } else {
      onMove(
        item.id,
        dateAt(weekStartDate, drag.dayIndex, drag.startMin),
        dateAt(weekStartDate, drag.dayIndex, drag.endMin),
      );
    }
    setDrag(null);
  }

  return (
    <div className="flex h-full flex-col no-select">
      {/* Day headers */}
      <div className="flex border-b border-line pr-3">
        <div className="w-14 shrink-0" />
        <div className="grid flex-1 grid-cols-7">
          {DAY_LABELS.map((label, i) => {
            const date = addDays(weekStartDate, i);
            const isToday = date.toDateString() === today.toDateString();
            const { planned, committed } = dayTotals[i];
            const over = planned + committed > DAILY_CAPACITY_MIN;

            return (
              <div key={label} className="px-1 py-2 text-center">
                <div className="text-xs text-muted">{label}</div>
                <div className={`text-sm font-medium ${isToday ? "text-accent" : ""}`}>
                  {date.getDate()}
                </div>
                <div
                  className={`text-[10px] tabular-nums ${over ? "text-red-500" : "text-muted"}`}
                  title={
                    committed > 0
                      ? `${fmtDuration(planned)} planned, ${fmtDuration(committed)} already committed`
                      : undefined
                  }
                >
                  {planned > 0 ? fmtDuration(planned) : "—"}
                  {committed > 0 && (
                    <span className="opacity-70"> +{fmtDuration(committed)}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* All-day strip. Marks a day without consuming ten hours of it. */}
      {allDay.length > 0 && (
        <div className="flex border-b border-line pr-3">
          <div className="flex w-14 shrink-0 items-center justify-end pr-2 text-[10px] text-muted">
            all day
          </div>
          <div className="grid flex-1 grid-cols-7">
            {Array.from({ length: 7 }, (_, dayIndex) => (
              <div key={dayIndex} className="min-h-6 border-l border-line p-0.5">
                {allDay
                  .filter((chip) => chip.dayIndex === dayIndex)
                  .map((chip) => (
                    <div
                      key={chip.id}
                      title={`${chip.label}${chip.title ? ` — ${chip.title}` : ""}${
                        chip.archived
                          ? "\nArchived — your calendar deleted this once it was over. Kept here."
                          : ""
                      }`}
                      className="mb-0.5 truncate rounded px-1 py-0.5 text-[10px] leading-tight"
                      style={{
                        backgroundColor: `${chip.color}22`,
                        borderLeft: `2px solid ${chip.color}`,
                        backgroundImage: chip.archived
                          ? `repeating-linear-gradient(45deg, ${chip.color}1f 0 4px, transparent 4px 9px)`
                          : undefined,
                      }}
                    >
                      {chip.title ?? chip.label}
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex pr-3">
          {/* Time gutter */}
          <div className="relative w-14 shrink-0" style={{ height: GRID_HEIGHT }}>
            {Array.from({ length: (DAY_END_MIN - DAY_START_MIN) / 60 + 1 }, (_, i) => {
              const minutes = DAY_START_MIN + i * 60;
              return (
                <div
                  key={minutes}
                  className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-muted"
                  style={{ top: slotToY(minutes) }}
                >
                  {fmtTime(minutes)}
                </div>
              );
            })}
          </div>

          {/* Day columns */}
          <div
            ref={colsRef}
            className="relative grid flex-1 grid-cols-7"
            style={{ height: GRID_HEIGHT }}
          >
            <div className="pointer-events-none absolute inset-0">
              {Array.from({ length: (DAY_END_MIN - DAY_START_MIN) / 60 + 1 }, (_, i) => (
                <div
                  key={i}
                  className="absolute inset-x-0 border-t border-line"
                  style={{ top: slotToY(DAY_START_MIN + i * 60) }}
                />
              ))}
            </div>

            {byDay.map((dayItems, dayIndex) => {
              const lanes = layoutLanes(
                dayItems.map((item) => {
                  const { startMin, endMin } = positionOf(item);
                  return { id: item.id, start: startMin, end: endMin };
                }),
              );

              return (
                <div
                  key={dayIndex}
                  className="relative touch-none border-l border-line"
                  onPointerDown={(e) => onColumnPointerDown(e, dayIndex)}
                  onPointerMove={onColumnPointerMove}
                  onPointerUp={onColumnPointerUp}
                  onDragOver={(e) => {
                    if (!pendingDrag) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                    setHover(slotFromPointer(e.clientX, e.clientY));
                  }}
                  onDragLeave={() => setHover(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (!pendingDrag) return;
                    const { dayIndex: di, startMin } = slotFromPointer(
                      e.clientX,
                      e.clientY,
                    );
                    setHover(null);
                    onCreateFromDrag(pendingDrag, dateAt(weekStartDate, di, startMin));
                  }}
                  onDoubleClick={(e) => {
                    if (e.target !== e.currentTarget) return;
                    const { dayIndex: di, startMin } = slotFromPointer(
                      e.clientX,
                      e.clientY,
                    );
                    openDraw(di, startMin, Math.min(startMin + 60, DAY_END_MIN));
                  }}
                >
                  {dayItems.map((item) => {
                    const { startMin, endMin } = positionOf(item);
                    const lane = lanes.get(item.id) ?? { lane: 0, lanes: 1 };
                    const isDragging = drag?.id === item.id;
                    const isSelected = selectedId === item.id;
                    const height = ((endMin - startMin) / SLOT_MIN) * PX_PER_SLOT;
                    const external = item.kind === "external";
                    // A block is a container: once it holds tasks, they carry the
                    // labels and the colour, and the block is only the dashed
                    // outline drawn around them.
                    const filled = item.children.length > 0;

                    return (
                      <div
                        key={item.id}
                        onPointerDown={(e) => onItemPointerDown(e, item)}
                        onPointerMove={onItemPointerMove}
                        onPointerUp={(e) => onItemPointerUp(e, item)}
                        title={itemTitle(item, startMin, endMin)}
                        className={`absolute touch-none overflow-hidden rounded-md text-[11px] leading-tight ${
                          external
                            ? `cursor-default border-l-[3px] border-y border-r px-1.5 py-0.5 ${
                                // Dotted, and hatched below: an archive is time
                                // that happened, held by nothing but this row.
                                item.archived ? "border-dotted" : "border-dashed"
                              }`
                            : filled
                              ? "cursor-grab border border-dashed p-[2px]"
                              : "cursor-grab border border-dashed px-1.5 py-0.5"
                        } ${isDragging ? "z-20 cursor-grabbing opacity-90" : "z-10"} ${
                          isSelected ? "ring-2 ring-accent" : ""
                        } ${item.done ? "opacity-60" : ""}`}
                        style={{
                          top: slotToY(startMin),
                          height: Math.max(height, PX_PER_SLOT),
                          left: `${(lane.lane / lane.lanes) * 100}%`,
                          width: `calc(${100 / lane.lanes}% - 3px)`,
                          ...(external
                            ? {
                                borderLeftColor: item.color,
                                borderTopColor: `${item.color}55`,
                                borderRightColor: `${item.color}55`,
                                borderBottomColor: `${item.color}55`,
                                // Flatter fill for time you do not control.
                                backgroundColor: `${item.color}14`,
                                // An archive reads as hatched rather than faded:
                                // it still counts, so it must not look spent.
                                backgroundImage: item.archived
                                  ? `repeating-linear-gradient(45deg, ${item.color}1f 0 4px, transparent 4px 9px)`
                                  : undefined,
                              }
                            : {
                                // Amber says the tasks ask for more time than the
                                // block holds, so the last of them is clipped.
                                borderColor: item.overfilled
                                  ? "#e8590c"
                                  : `${item.color}66`,
                                backgroundColor: filled
                                  ? "transparent"
                                  : `${item.color}12`,
                              }),
                        }}
                      >
                        {filled ? (
                          <div className="relative h-full">
                            {item.children.map((child) => {
                              const childTop =
                                (child.offsetMinutes / SLOT_MIN) * PX_PER_SLOT;
                              const childHeight =
                                (child.minutes / SLOT_MIN) * PX_PER_SLOT;

                              return (
                                <div
                                  key={child.id}
                                  title={`${child.label}${
                                    child.description ? ` — ${child.description}` : ""
                                  } · ${fmtDuration(child.minutes)}`}
                                  className="absolute inset-x-0 overflow-hidden rounded-sm border-l-[3px] px-1 shadow-sm"
                                  style={{
                                    top: childTop,
                                    height: Math.max(childHeight - 1, 8),
                                    borderLeftColor: child.color,
                                    backgroundColor: `${child.color}26`,
                                  }}
                                >
                                  <span className="block truncate font-medium">
                                    {child.label}
                                  </span>
                                  {child.description &&
                                    childHeight >= PX_PER_SLOT * 3 && (
                                      <span className="block truncate text-muted">
                                        {child.description}
                                      </span>
                                    )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <>
                            <div className="flex items-baseline gap-1">
                              {external && (
                                <span
                                  className="shrink-0 opacity-60"
                                  title={
                                    item.archived
                                      ? "Archived from a calendar"
                                      : "From a calendar"
                                  }
                                >
                                  {item.archived ? "⧗" : "⧉"}
                                </span>
                              )}
                              <span className="truncate font-medium">
                                {item.label || (
                                  <span className="text-muted">Empty block</span>
                                )}
                              </span>
                            </div>
                            {item.description &&
                              item.description !== item.label &&
                              height >= PX_PER_SLOT * 3 && (
                                <div className="truncate text-muted">
                                  {item.description}
                                </div>
                              )}
                            {height >= PX_PER_SLOT * 5 && (
                              <div className="truncate text-muted">
                                {fmtTime(startMin)}–{fmtTime(endMin)}
                              </div>
                            )}
                          </>
                        )}
                        {item.movable && (
                          <div
                            data-resize="true"
                            className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
                          />
                        )}
                      </div>
                    );
                  })}

                  {/* Selection being drawn */}
                  {drawnRange && draw?.dayIndex === dayIndex && (
                    <div
                      className="pointer-events-none absolute inset-x-0 z-20 rounded-md border-2 border-accent bg-accent/15"
                      style={{
                        top: slotToY(drawnRange.startMin),
                        height:
                          ((drawnRange.endMin - drawnRange.startMin) / SLOT_MIN) *
                          PX_PER_SLOT,
                      }}
                    >
                      <div className="px-1.5 py-0.5 text-[10px] tabular-nums text-accent">
                        {fmtTime(drawnRange.startMin)}–{fmtTime(drawnRange.endMin)}
                      </div>
                    </div>
                  )}

                  {/* Drop preview */}
                  {hover && hover.dayIndex === dayIndex && pendingDrag && (
                    <div
                      className="pointer-events-none absolute inset-x-0 z-0 rounded-md border border-dashed border-accent bg-accent/10"
                      style={{
                        top: slotToY(hover.startMin),
                        height:
                          (Math.max(pendingDrag.minutes, SLOT_MIN) / SLOT_MIN) *
                          PX_PER_SLOT,
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
