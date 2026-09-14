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
import type { DragPayload, ScheduledBlock } from "@/lib/types";
import { busyMinutesByDay, overlapsBusy, type BusySegment } from "@/lib/busy";

/** Soft cap per day; crossing it turns the day total red. */
export const DAILY_CAPACITY_MIN = 10 * 60;

const GRID_HEIGHT = SLOTS_PER_DAY * PX_PER_SLOT;

type Span = { id: string; start: number; end: number };

/**
 * Greedy lane assignment so overlapping blocks sit side by side instead of on
 * top of each other. Blocks are grouped into clusters of mutual overlap; every
 * block in a cluster shares the same lane count, which keeps widths stable.
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

type DragState = {
  id: string;
  mode: "move" | "resize";
  dayIndex: number;
  startMin: number;
  endMin: number;
  grabY: number;
  moved: boolean;
};

export type DrawnRange = {
  startsAt: Date;
  endsAt: Date;
  /** True when the drawn span lands on time already committed in Google. */
  overBusy: boolean;
  anchor: { top: number; bottom: number; left: number; right: number };
};

type Props = {
  weekStartDate: Date;
  blocks: ScheduledBlock[];
  colorFor: (block: ScheduledBlock) => string;
  /** Category leaf, or a template's own name. Titles no longer exist. */
  labelFor: (block: ScheduledBlock) => string;
  selectedId: string | null;
  pendingDrag: DragPayload | null;
  busy: BusySegment[];
  onSelect: (id: string | null) => void;
  onCreateFromDrag: (payload: DragPayload, startsAt: Date) => void;
  onDraw: (range: DrawnRange) => void;
  onMove: (id: string, startsAt: Date, endsAt: Date) => void;
};

export function WeekGrid({
  weekStartDate,
  blocks,
  colorFor,
  labelFor,
  selectedId,
  pendingDrag,
  busy,
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

  /** Where a block sits right now — mid-drag values win over stored ones. */
  const positionOf = (block: ScheduledBlock) => {
    if (drag && drag.id === block.id) {
      return {
        dayIndex: drag.dayIndex,
        startMin: drag.startMin,
        endMin: drag.endMin,
      };
    }
    const start = new Date(block.starts_at);
    const end = new Date(block.ends_at);
    return {
      dayIndex: dayIndexOf(weekStartDate, start),
      startMin: minutesOfDay(start),
      endMin: minutesOfDay(start) + Math.round((end.getTime() - start.getTime()) / 60_000),
    };
  };

  const byDay: ScheduledBlock[][] = Array.from({ length: 7 }, () => []);
  for (const b of blocks) {
    const { dayIndex } = positionOf(b);
    if (dayIndex >= 0) byDay[dayIndex].push(b);
  }

  const dayTotals = byDay.map((list) =>
    list.reduce((sum, b) => {
      const { startMin, endMin } = positionOf(b);
      return sum + (endMin - startMin);
    }, 0),
  );

  // Time already committed in Google is not time you can plan into, so capacity
  // is what remains after it — otherwise the overload warning lies.
  const busyPerDay = busyMinutesByDay(busy);

  /** Placing over committed time is allowed, but never by accident. */
  function confirmOverBusy(dayIndex: number, startMin: number, endMin: number) {
    if (!overlapsBusy(busy, dayIndex, startMin, endMin)) return true;
    return confirm("That time is already committed in Google Calendar. Place it anyway?");
  }

  /** Selection bounds, normalised so dragging upward works. */
  const drawnRange = draw
    ? {
        startMin: Math.min(draw.anchorMin, draw.currentMin),
        endMin: Math.max(draw.anchorMin, draw.currentMin),
      }
    : null;

  function onColumnPointerDown(e: React.PointerEvent<HTMLDivElement>, dayIndex: number) {
    // Blocks are children of this column. Without this guard, grabbing a block
    // would also start a selection underneath it.
    if (e.target !== e.currentTarget) return;
    if (e.button !== 0) return;

    e.currentTarget.setPointerCapture(e.pointerId);
    const { startMin } = slotFromPointer(e.clientX, e.clientY);
    setDraw({ dayIndex, anchorMin: startMin, currentMin: startMin + SLOT_MIN, moved: false });
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
      // Surfaced in the popup rather than as a confirm(): interrupting a drag
      // with a modal to say something the form can state calmly is hostile.
      overBusy: overlapsBusy(busy, dayIndex, startMin, endMin),
      anchor: {
        top: rect.top + slotToY(startMin),
        bottom: rect.top + slotToY(endMin),
        left: rect.left + dayIndex * colWidth,
        right: rect.left + (dayIndex + 1) * colWidth,
      },
    });
  }

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

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>, block: ScheduledBlock) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const mode: "move" | "resize" = target.dataset.resize === "true" ? "resize" : "move";

    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);

    const rect = colsRef.current!.getBoundingClientRect();
    const { dayIndex, startMin, endMin } = positionOf(block);
    const blockTop = rect.top + slotToY(startMin);

    setDrag({
      id: block.id,
      mode,
      dayIndex,
      startMin,
      endMin,
      grabY: e.clientY - blockTop,
      moved: false,
    });
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
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

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>, block: ScheduledBlock) {
    if (!drag || drag.id !== block.id) return;
    e.currentTarget.releasePointerCapture(e.pointerId);

    if (!drag.moved) {
      onSelect(block.id === selectedId ? null : block.id);
    } else {
      onMove(
        block.id,
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
            const total = dayTotals[i];
            const committed = busyPerDay[i];
            const available = Math.max(0, DAILY_CAPACITY_MIN - committed);
            return (
              <div key={label} className="px-1 py-2 text-center">
                <div className="text-xs text-muted">{label}</div>
                <div
                  className={`text-sm font-medium ${isToday ? "text-accent" : ""}`}
                >
                  {date.getDate()}
                </div>
                <div
                  className={`text-[10px] tabular-nums ${
                    total > available ? "text-red-500" : "text-muted"
                  }`}
                  title={
                    committed > 0
                      ? `${fmtDuration(committed)} committed in Google, ${fmtDuration(available)} left to plan`
                      : undefined
                  }
                >
                  {total > 0 ? fmtDuration(total) : "—"}
                  {committed > 0 && (
                    <span className="text-muted"> +{fmtDuration(committed)}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

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
            {/* Hour lines, drawn once across the full width */}
            <div className="pointer-events-none absolute inset-0">
              {Array.from({ length: (DAY_END_MIN - DAY_START_MIN) / 60 + 1 }, (_, i) => (
                <div
                  key={i}
                  className="absolute inset-x-0 border-t border-line"
                  style={{ top: slotToY(DAY_START_MIN + i * 60) }}
                />
              ))}
            </div>

            {byDay.map((dayBlocks, dayIndex) => {
              const lanes = layoutLanes(
                dayBlocks.map((b) => {
                  const { startMin, endMin } = positionOf(b);
                  return { id: b.id, start: startMin, end: endMin };
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
                    if (!confirmOverBusy(di, startMin, startMin + pendingDrag.minutes)) {
                      return;
                    }
                    onCreateFromDrag(pendingDrag, dateAt(weekStartDate, di, startMin));
                  }}
                  onDoubleClick={(e) => {
                    if (e.target !== e.currentTarget) return;
                    const { dayIndex: di, startMin } = slotFromPointer(
                      e.clientX,
                      e.clientY,
                    );
                    const endMin = Math.min(startMin + 60, DAY_END_MIN);
                    openDraw(di, startMin, endMin);
                  }}
                >
                  {busy
                    .filter((segment) => segment.dayIndex === dayIndex)
                    .map((segment) => (
                      <div
                        key={segment.id}
                        title={segment.title ?? "Busy"}
                        className="pointer-events-none absolute inset-x-0 z-0 border-y border-line/60"
                        style={{
                          top: slotToY(segment.startMin),
                          height:
                            ((segment.endMin - segment.startMin) / SLOT_MIN) * PX_PER_SLOT,
                          backgroundImage:
                            "repeating-linear-gradient(45deg, var(--color-muted) 0 1px, transparent 1px 7px)",
                          opacity: 0.28,
                        }}
                      />
                    ))}

                  {dayBlocks.map((block) => {
                    const { startMin, endMin } = positionOf(block);
                    const lane = lanes.get(block.id) ?? { lane: 0, lanes: 1 };
                    const color = colorFor(block);
                    const isDragging = drag?.id === block.id;
                    const isSelected = selectedId === block.id;
                    const height = ((endMin - startMin) / SLOT_MIN) * PX_PER_SLOT;

                    return (
                      <div
                        key={block.id}
                        onPointerDown={(e) => onPointerDown(e, block)}
                        onPointerMove={onPointerMove}
                        onPointerUp={(e) => onPointerUp(e, block)}
                        className={`absolute cursor-grab touch-none overflow-hidden rounded-md border-l-[3px] px-1.5 py-0.5 text-[11px] leading-tight shadow-sm ${
                          isDragging ? "z-20 cursor-grabbing opacity-90" : "z-10"
                        } ${isSelected ? "ring-2 ring-accent" : ""} ${
                          block.status === "done" ? "opacity-60" : ""
                        }`}
                        style={{
                          top: slotToY(startMin),
                          height: Math.max(height, PX_PER_SLOT),
                          left: `${(lane.lane / lane.lanes) * 100}%`,
                          width: `calc(${100 / lane.lanes}% - 3px)`,
                          borderLeftColor: color,
                          backgroundColor: `${color}22`,
                        }}
                      >
                        <div className="truncate font-medium">{labelFor(block)}</div>
                        {block.description && height >= PX_PER_SLOT * 3 && (
                          <div className="truncate text-muted">{block.description}</div>
                        )}
                        {height >= PX_PER_SLOT * 5 && (
                          <div className="truncate text-muted">
                            {fmtTime(startMin)}–{fmtTime(endMin)}
                          </div>
                        )}
                        <div
                          data-resize="true"
                          className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
                        />
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
