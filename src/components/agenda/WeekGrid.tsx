"use client";

import { useRef, useState, useSyncExternalStore } from "react";
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
import { resizedChildMinutes } from "@/lib/blocks";

/** Soft cap per day. Planned and committed time are measured against it together. */
export const DAILY_CAPACITY_MIN = 10 * 60;

const GRID_HEIGHT = SLOTS_PER_DAY * PX_PER_SLOT;

/**
 * What a hidden category is drawn in. Hiding is a reading of the week, not an
 * edit to it: the hours stay exactly where they are, in grey, so the shape of
 * the day survives and you can still see what you chose to look past.
 */
const HIDDEN_COLOR = "#9ca3af";

/**
 * A block has no category, so it only reads as hidden once everything inside it
 * is — an outline around nothing but hidden tasks is itself nothing to look at.
 * An empty block has no category to hide and always stays.
 */
function isItemHidden(item: GridItem, hidden: ReadonlySet<string>) {
  if (hidden.size === 0) return false;
  if (item.categoryId !== null) return hidden.has(item.categoryId);
  return (
    item.children.length > 0 &&
    item.children.every((c) => c.categoryId !== null && hidden.has(c.categoryId))
  );
}

type Span = { id: string; start: number; end: number };

/** Minutes a set of spans actually covers — time shared by two of them counts once. */
function coveredMinutes(spans: { startMin: number; endMin: number }[]) {
  return mergeSpans(spans).reduce((sum, s) => sum + (s.endMin - s.startMin), 0);
}

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

const MINUTE_MS = 60_000;

/**
 * The clock is an external store, so it is subscribed to rather than polled
 * into state. Ticks are lined up with the minute boundary: a plain interval
 * started on mount would drift the caret up to a minute behind the clock it
 * mirrors.
 */
function subscribeToMinute(onTick: () => void) {
  let interval: ReturnType<typeof setInterval> | undefined;
  const timeout = setTimeout(
    () => {
      onTick();
      interval = setInterval(onTick, MINUTE_MS);
    },
    MINUTE_MS - (Date.now() % MINUTE_MS),
  );

  return () => {
    clearTimeout(timeout);
    if (interval) clearInterval(interval);
  };
}

/** Minute resolution, so the snapshot only changes when the caret would move. */
const minuteNow = () => Math.floor(Date.now() / MINUTE_MS);

/** The server has no "now" worth rendering, and hydration must not disagree. */
const noServerNow = () => null;

/** The current minute, or `null` until the client has taken over. */
function useNow(): Date | null {
  const minute = useSyncExternalStore<number | null>(
    subscribeToMinute,
    minuteNow,
    noServerNow,
  );
  return minute === null ? null : new Date(minute * MINUTE_MS);
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
  /**
   * Which days the body draws, in order, as indices into the week.
   *
   * A narrow screen cannot give seven columns enough width to drop a block into
   * one on purpose, so it shows a single day and the header turns into the
   * picker for it. Everything else — lane widths, the pointer maths, the drop
   * preview — reads its column count from here rather than assuming seven.
   */
  days: number[];
  /** Categories being read past. Their time greys out instead of vanishing. */
  hiddenCategories: ReadonlySet<string>;
  selectedId: string | null;
  pendingDrag: DragPayload | null;
  onSelect: (id: string | null) => void;
  onCreateFromDrag: (payload: DragPayload, startsAt: Date) => void;
  onDraw: (range: DrawnRange) => void;
  onMove: (id: string, startsAt: Date, endsAt: Date) => void;
  /** Only meaningful while the body is showing fewer than seven days. */
  onFocusDay: (dayIndex: number) => void;
};

export function WeekGrid({
  weekStartDate,
  items,
  allDay,
  days,
  hiddenCategories,
  selectedId,
  pendingDrag,
  onSelect,
  onCreateFromDrag,
  onDraw,
  onMove,
  onFocusDay,
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

  /** How many columns the body is drawing, and where a given day sits in them. */
  const colCount = Math.max(days.length, 1);
  const isPicker = days.length < 7;
  const columnOf = (dayIndex: number) => days.indexOf(dayIndex);

  // The caret only exists when the current moment is actually on screen: this
  // week, the day being shown, and inside the hours the grid draws.
  const now = useNow();
  const nowMin = now ? minutesOfDay(now) : 0;
  const nowDayIndex = now ? dayIndexOf(weekStartDate, now) : -1;
  const nowColumn = columnOf(nowDayIndex);
  const showNow =
    nowDayIndex >= 0 &&
    nowColumn >= 0 &&
    nowMin >= DAY_START_MIN &&
    nowMin <= DAY_END_MIN;
  // Unsnapped, unlike everything else on the grid — a marker for the time it is
  // would be a lie if it rounded to the nearest quarter hour.
  const nowY = slotToY(nowMin);

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
  //
  // Every figure here is a union of spans rather than a sum of durations. Two
  // blocks laid over the same hour are one hour of the day, not two — the day
  // has no more room for being booked twice over.
  const dayTotals = byDay.map((list) => {
    const plannedSpans: { startMin: number; endMin: number }[] = [];
    const committedSpans: { startMin: number; endMin: number }[] = [];

    for (const item of list) {
      const { startMin, endMin } = positionOf(item);
      if (item.kind === "external") committedSpans.push({ startMin, endMin });
      else plannedSpans.push({ startMin, endMin });
    }

    return {
      planned: coveredMinutes(plannedSpans),
      committed: coveredMinutes(committedSpans),
      // What the day really costs. The two figures above overlap each other as
      // readily as they overlap themselves, so they cannot just be added.
      busy: coveredMinutes([...plannedSpans, ...committedSpans]),
    };
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
    const colWidth = rect.width / colCount;
    const column = clamp(
      Math.floor((clientX - rect.left) / colWidth),
      0,
      colCount - 1,
    );
    const dayIndex = days[column] ?? days[0] ?? 0;
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
    const colWidth = rect.width / colCount;
    // The anchor is where the selection is on screen, so it follows the column
    // the day is drawn in — not the day's place in the week.
    const column = Math.max(columnOf(dayIndex), 0);

    onDraw({
      startsAt: dateAt(weekStartDate, dayIndex, startMin),
      endsAt: dateAt(weekStartDate, dayIndex, endMin),
      overCommitted: overlapsCommitted(dayIndex, startMin, endMin),
      anchor: {
        top: rect.top + slotToY(startMin),
        bottom: rect.top + slotToY(endMin),
        left: rect.left + column * colWidth,
        right: rect.left + (column + 1) * colWidth,
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
    const colWidth = rect.width / colCount;
    const duration = drag.endMin - drag.startMin;

    if (drag.mode === "move") {
      const column = clamp(
        Math.floor((e.clientX - rect.left) / colWidth),
        0,
        colCount - 1,
      );
      const dayIndex = days[column] ?? drag.dayIndex;
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

  /**
   * A touch that the browser decides to treat as a scroll takes the pointer
   * away mid-gesture. Without this the grid keeps the half-finished drag in
   * state and paints the block where the finger last was, for good.
   */
  function onItemPointerCancel() {
    setDrag(null);
  }

  function onColumnPointerCancel() {
    setDraw(null);
  }

  return (
    <div className="flex h-full flex-col no-select">
      {/* Day headers. With fewer columns than days these double as the picker
          for which day the body is showing, so they stay seven wide. */}
      <div className="flex border-b border-line pr-1 sm:pr-3">
        <div className="w-10 shrink-0 sm:w-14" />
        <div className="grid flex-1 grid-cols-7">
          {DAY_LABELS.map((label, i) => {
            const date = addDays(weekStartDate, i);
            const isToday = date.toDateString() === today.toDateString();
            const { planned, committed, busy } = dayTotals[i];
            const over = busy > DAILY_CAPACITY_MIN;
            const focused = isPicker && days.includes(i);

            const body = (
              <>
                <div
                  className={`text-[10px] sm:text-xs ${
                    focused ? "text-white/80" : "text-muted"
                  }`}
                >
                  {label}
                </div>
                <div
                  className={`text-sm font-medium ${
                    focused ? "" : isToday ? "text-accent" : ""
                  }`}
                >
                  {date.getDate()}
                </div>
                <div
                  className={`text-[10px] tabular-nums ${
                    focused ? "opacity-80" : over ? "text-red-500" : "text-muted"
                  }`}
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
              </>
            );

            if (!isPicker) {
              return (
                <div key={label} className="px-1 py-2 text-center">
                  {body}
                </div>
              );
            }

            return (
              <button
                key={label}
                type="button"
                onClick={() => onFocusDay(i)}
                aria-pressed={focused}
                className={`m-0.5 rounded-md px-0.5 py-1.5 text-center transition-colors ${
                  focused
                    ? "bg-accent text-white"
                    : isToday
                      ? "text-accent hover:bg-line/50"
                      : "hover:bg-line/50"
                }`}
              >
                {body}
              </button>
            );
          })}
        </div>
      </div>

      {/* All-day strip. Marks a day without consuming ten hours of it. */}
      {allDay.length > 0 && (
        <div className="flex border-b border-line pr-1 sm:pr-3">
          <div className="flex w-10 shrink-0 items-center justify-end pr-1 text-[10px] leading-tight text-muted sm:w-14 sm:pr-2">
            all day
          </div>
          <div
            className="grid flex-1"
            style={{ gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))` }}
          >
            {days.map((dayIndex) => (
              <div key={dayIndex} className="min-h-6 border-l border-line p-0.5">
                {allDay
                  .filter((chip) => chip.dayIndex === dayIndex)
                  .map((chip) => {
                    const dimmed =
                      chip.categoryId !== null && hiddenCategories.has(chip.categoryId);
                    const tint = dimmed ? HIDDEN_COLOR : chip.color;

                    return (
                      <div
                        key={chip.id}
                        title={`${chip.label}${chip.title ? ` — ${chip.title}` : ""}${
                          chip.archived
                            ? "\nArchived — your calendar deleted this once it was over. Kept here."
                            : ""
                        }`}
                        className={`mb-0.5 truncate rounded px-1 py-0.5 text-[10px] leading-tight ${
                          dimmed ? "text-muted opacity-60" : ""
                        }`}
                        style={{
                          backgroundColor: `${tint}22`,
                          borderLeft: `2px solid ${tint}`,
                          backgroundImage: chip.archived
                            ? `repeating-linear-gradient(45deg, ${tint}1f 0 4px, transparent 4px 9px)`
                            : undefined,
                        }}
                      >
                        {chip.title ?? chip.label}
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="flex pr-1 sm:pr-3">
          {/* Time gutter */}
          <div
            className="relative w-10 shrink-0 sm:w-14"
            style={{ height: GRID_HEIGHT }}
          >
            {Array.from({ length: (DAY_END_MIN - DAY_START_MIN) / 60 + 1 }, (_, i) => {
              const minutes = DAY_START_MIN + i * 60;
              return (
                <div
                  key={minutes}
                  className="absolute right-1 -translate-y-1/2 text-[10px] tabular-nums text-muted sm:right-2"
                  style={{ top: slotToY(minutes) }}
                >
                  {fmtTime(minutes)}
                </div>
              );
            })}

            {/* Caret on the ruler, pointing into the week. */}
            {showNow && (
              <div
                className="absolute right-0 z-30 h-0 w-0 -translate-y-1/2 border-y-4 border-y-transparent border-l-[6px] border-l-red-500"
                style={{ top: nowY }}
                title={`Now — ${fmtTime(nowMin)}`}
              />
            )}
          </div>

          {/* Day columns */}
          <div
            ref={colsRef}
            className="relative grid flex-1"
            style={{
              height: GRID_HEIGHT,
              gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))`,
            }}
          >
            <div className="pointer-events-none absolute inset-0">
              {Array.from({ length: (DAY_END_MIN - DAY_START_MIN) / 60 + 1 }, (_, i) => (
                <div
                  key={i}
                  className="absolute inset-x-0 border-t border-line"
                  style={{ top: slotToY(DAY_START_MIN + i * 60) }}
                />
              ))}

              {/* Today's column gets the line; the rest of the week does not. */}
              {showNow && (
                <div
                  className="absolute z-30 flex -translate-y-1/2 items-center"
                  style={{
                    top: nowY,
                    left: `${(nowColumn / colCount) * 100}%`,
                    width: `${100 / colCount}%`,
                  }}
                >
                  <span className="-ml-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                  <span className="h-px flex-1 bg-red-500" />
                </div>
              )}
            </div>

            {days.map((dayIndex) => {
              const dayItems = byDay[dayIndex] ?? [];
              const lanes = layoutLanes(
                dayItems.map((item) => {
                  const { startMin, endMin } = positionOf(item);
                  return { id: item.id, start: startMin, end: endMin };
                }),
              );

              return (
                <div
                  key={dayIndex}
                  /**
                   * `touch-pan-y` rather than `touch-none`: the empty parts of a
                   * column are most of the grid on a phone, and taking the
                   * browser's scroll away from them leaves the day unscrollable.
                   * Drawing a range by finger goes with it — double-tap opens a
                   * one-hour draft instead — while dragging a block still works,
                   * because the blocks themselves keep `touch-none`.
                   */
                  className="relative touch-pan-y border-l border-line md:touch-none"
                  onPointerDown={(e) => onColumnPointerDown(e, dayIndex)}
                  onPointerMove={onColumnPointerMove}
                  onPointerUp={onColumnPointerUp}
                  onPointerCancel={onColumnPointerCancel}
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

                    // Mid-resize, a single task stretches with its block, as it
                    // will once the move lands (resizedChildMinutes).
                    const storedMinutes = Math.round(
                      (new Date(item.endsAt).getTime() -
                        new Date(item.startsAt).getTime()) /
                        60_000,
                    );
                    const childSpans =
                      drag?.id === item.id && drag.mode === "resize"
                        ? resizedChildMinutes(
                            item.children.map((c) => c.minutes),
                            storedMinutes,
                            endMin - startMin,
                          )
                        : item.children.map((c) => c.minutes);

                    const hasMultipleChildren = item.children.length > 1;

                    // A filled block only greys its outline. Its children fade
                    // on their own, and stacking both would leave the block
                    // barely there — hidden time still has to be findable.
                    const dimmed = isItemHidden(item, hiddenCategories);
                    const tint = dimmed ? HIDDEN_COLOR : item.color;

                    return (
                      <div
                        key={item.id}
                        onPointerDown={(e) => onItemPointerDown(e, item)}
                        onPointerMove={onItemPointerMove}
                        onPointerUp={(e) => onItemPointerUp(e, item)}
                        onPointerCancel={onItemPointerCancel}
                        title={itemTitle(item, startMin, endMin)}
                        className={`absolute touch-none overflow-hidden rounded-md text-[11px] leading-tight ${
                          external
                            ? `cursor-default border-l-[3px] border-y border-r px-1.5 py-0.5 ${
                                // Dotted, and hatched below: an archive is time
                                // that happened, held by nothing but this row.
                                item.archived ? "border-dotted" : "border-dashed"
                              }`
                            : filled
                              ? hasMultipleChildren
                                ? "cursor-grab border border-dashed p-[2px]"
                                : "cursor-grab py-0.5"
                              : "cursor-grab border border-dashed px-1.5 py-0.5"
                        } ${isDragging ? "z-20 cursor-grabbing opacity-90" : "z-10"} ${
                          isSelected ? "ring-2 ring-accent" : ""
                        } ${
                          dimmed && !filled
                            ? "text-muted opacity-55"
                            : item.done
                              ? "opacity-60"
                              : ""
                        }`}
                        style={{
                          top: slotToY(startMin),
                          height: Math.max(height, PX_PER_SLOT),
                          left: `${(lane.lane / lane.lanes) * 100}%`,
                          width: `calc(${100 / lane.lanes}% - 3px)`,
                          ...(external
                            ? {
                                borderLeftColor: tint,
                                borderTopColor: `${tint}55`,
                                borderRightColor: `${tint}55`,
                                borderBottomColor: `${tint}55`,
                                // Flatter fill for time you do not control.
                                backgroundColor: `${tint}14`,
                                // An archive reads as hatched rather than faded:
                                // it still counts, so it must not look spent.
                                backgroundImage: item.archived
                                  ? `repeating-linear-gradient(45deg, ${tint}1f 0 4px, transparent 4px 9px)`
                                  : undefined,
                              }
                            : {
                                // Amber says the tasks ask for more time than the
                                // block holds, so the last of them is clipped.
                                // A hidden block is not worth warning about.
                                borderColor:
                                  item.overfilled && !dimmed
                                    ? "#e8590c"
                                    : `${tint}66`,
                                backgroundColor: filled
                                  ? "transparent"
                                  : `${tint}12`,
                              }),
                        }}
                      >
                        {filled ? (
                          <div className="relative h-full">
                            {item.children.map((child, i) => {
                              const childTop =
                                (child.offsetMinutes / SLOT_MIN) * PX_PER_SLOT;
                              const childHeight =
                                (childSpans[i] / SLOT_MIN) * PX_PER_SLOT;
                              const childDimmed =
                                child.categoryId !== null &&
                                hiddenCategories.has(child.categoryId);
                              const childTint = childDimmed
                                ? HIDDEN_COLOR
                                : child.color;

                              return (
                                <div
                                  key={child.id}
                                  title={`${child.label}${
                                    child.description ? ` — ${child.description}` : ""
                                  } · ${fmtDuration(childSpans[i])}${
                                    childDimmed ? "\nHidden from the week's totals." : ""
                                  }`}
                                  className={`absolute inset-x-0 overflow-hidden rounded-sm border-l-[3px] px-1 shadow-sm ${
                                    childDimmed ? "text-muted opacity-55" : ""
                                  }`}
                                  style={{
                                    top: childTop,
                                    height: Math.max(childHeight - 1, 8),
                                    borderLeftColor: childTint,
                                    backgroundColor: `${childTint}26`,
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
                            /* Fatter by touch, where there is no hover to aim with. */
                            className="absolute inset-x-0 bottom-0 h-2.5 cursor-ns-resize md:h-1.5"
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
