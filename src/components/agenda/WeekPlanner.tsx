"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { categoryIndex, subtreeIds, DEFAULT_COLOR } from "@/lib/categories";
import { MD, XL, useHydrated, useMediaQuery } from "@/lib/media";
import {
  addDays,
  dayIndexOf,
  fmtDuration,
  fmtWeekRange,
  fromISODate,
  toISODate,
} from "@/lib/time";
import type {
  AllDayItem,
  CalendarSource,
  Category,
  DragPayload,
  ExternalEvent,
  GoogleAccount,
  GridItem,
  Objective,
  Task,
  TaskSession,
  Week,
} from "@/lib/types";
import { externalItems, externalMinutesByCategory } from "@/lib/external";
import { counts, isMissed, moveReschedules, sessionMinutes } from "@/lib/agenda/sessions";
import { CalendarLiveness } from "./CalendarLiveness";
import { ExternalDetail } from "./ExternalDetail";
import { createTaskOnGrid, moveScheduled, placeTask } from "@/server/actions/schedule";
import { SessionPopup, type DraftSlot, type DraftChoice } from "./SessionPopup";
import { relativeTime } from "./GoogleConnection";
import { SessionDetail } from "./SessionDetail";
import { PlannerRail } from "./PlannerRail";
import { WeekGrid, type DrawnRange } from "./WeekGrid";
import { WeekIntent } from "./WeekIntent";
import { useNow } from "./useNow";

type Props = {
  weekStart: string;
  week: Week;
  categories: Category[];
  tasks: Task[];
  sessions: TaskSession[];
  objectives: Objective[];
  externalEvents: ExternalEvent[];
  calendarSources: CalendarSource[];
  googleAccount: GoogleAccount | null;
  oldestSyncAt: string | null;
};

export function WeekPlanner({
  weekStart,
  week,
  categories,
  tasks,
  sessions,
  objectives,
  externalEvents,
  calendarSources,
  googleAccount,
  oldestSyncAt,
}: Props) {
  const weekStartDate = useMemo(() => fromISODate(weekStart), [weekStart]);

  /**
   * The grid owns the placed sessions between server renders.
   *
   * This used to be `useOptimistic` over the server prop, which meant
   * every drag had to be followed by a route re-render: as soon as the action
   * settled React dropped the optimistic value and fell back to the prop, so
   * without a refresh the slot snapped back to where it started. Holding the
   * list in real state lets a move persist on the strength of the write alone.
   *
   * The prop is still the source of truth whenever the server sends a new one —
   * a week navigation, or any action that does refresh — so it re-seeds on a
   * new prop identity. Adjusting state during render is the documented way to
   * do that; an effect would paint the stale list first.
   */
  const [items, setItems] = useState<TaskSession[]>(sessions);
  const [seededFrom, setSeededFrom] = useState(sessions);
  if (seededFrom !== sessions) {
    setSeededFrom(sessions);
    setItems(sessions);
  }

  const [pendingDrag, setPendingDrag] = useState<DragPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftSlot | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  /**
   * Categories the week is currently being read without. Nothing but a lens:
   * it is never written anywhere, and it survives no reload — hiding a category
   * asks "what does the week look like without this", it does not change it.
   *
   * Held here rather than in the panel that toggles it, because the panel is
   * unmounted whenever a slot is selected and the grid must keep reading it.
   */
  const [hiddenCategories, setHiddenCategories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [, startTransition] = useTransition();

  /**
   * Below `md` the grid shows one day; below `xl` the two side panels are
   * drawers rather than columns. Both are CSS decisions everywhere except the
   * grid, which has to know its column count to lay anything out at all.
   */
  const wideGrid = useMediaQuery(MD);
  const wideLayout = useMediaQuery(XL);
  const hydrated = useHydrated();

  /**
   * Which day the one-day grid is showing: whichever you last tapped, and
   * failing that today — Monday in any week that does not contain today, and
   * during the server render, which has no business deciding what today is.
   *
   * Navigating to another week forgets the tap, the same way the grid re-seeds
   * itself from a new `sessions` prop.
   */
  const [pickedDay, setPickedDay] = useState<number | null>(null);
  /**
   * The day the time-by-category panel is reading instead of the whole week.
   * A lens like hidden categories: never stored, and forgotten with the week.
   */
  const [breakdownDay, setBreakdownDay] = useState<number | null>(null);
  const [pickedFor, setPickedFor] = useState(weekStart);
  if (pickedFor !== weekStart) {
    setPickedFor(weekStart);
    setPickedDay(null);
    setBreakdownDay(null);
  }

  const todayIndex = hydrated ? dayIndexOf(weekStartDate, new Date()) : -1;
  const focusDay =
    pickedDay ?? (todayIndex >= 0 && todayIndex <= 6 ? todayIndex : 0);

  const days = useMemo(
    () => (wideGrid ? [0, 1, 2, 3, 4, 5, 6] : [focusDay]),
    [wideGrid, focusDay],
  );

  /**
   * Which panel the narrow layout is showing over the grid. Ignored once both
   * panels have columns of their own to live in — and closed on the way there,
   * so a sheet left open across a resize does not sit on top of the column that
   * now holds the same panel.
   */
  const [drawer, setDrawer] = useState<"none" | "rail" | "detail">("none");
  const [drawerFor, setDrawerFor] = useState(wideLayout);
  if (drawerFor !== wideLayout) {
    setDrawerFor(wideLayout);
    if (wideLayout) setDrawer("none");
  }

  const googleConnected = Boolean(googleAccount && !googleAccount.disconnected_at);

  const categories_ = useMemo(() => categoryIndex(categories), [categories]);

  // A planned slot becomes missed through the clock alone; the server render
  // has no "now" to decide that with, so it waits for the client.
  const now = useNow();
  const nowMs = now?.getTime() ?? null;

  const external = useMemo(
    () =>
      googleConnected
        ? externalItems(externalEvents, calendarSources, weekStartDate)
        : ({ items: [] as GridItem[], allDay: [] as AllDayItem[] }),
    [externalEvents, calendarSources, weekStartDate, googleConnected],
  );

  /** Grid ids for external segments encode source and event; map back for detail. */
  const externalById = useMemo(() => {
    const sources = new Map(calendarSources.map((s) => [s.id, s]));
    const out = new Map<string, { event: ExternalEvent; source: CalendarSource }>();
    // All-day chips use the same id scheme, so they open the same detail.
    for (const item of [...external.items, ...external.allDay]) {
      const [sourceId, eventId] = item.id.split(":");
      const source = sources.get(sourceId);
      const event = externalEvents.find(
        (e) => e.calendar_source_id === sourceId && e.external_event_id === eventId,
      );
      if (source && event) out.set(item.id, { event, source });
    }
    return out;
  }, [external.items, external.allDay, externalEvents, calendarSources]);

  /**
   * One list for the grid. Sessions and external events are stored apart —
   * the mirror is read-only — but they lay out together, so they are
   * normalised here. A session is drawn as its task: the category leaf, in
   * the category's colour, with the task's description under it.
   */
  const gridItems: GridItem[] = useMemo(
    () => [
      ...items.map((s): GridItem => {
        const category = s.tasks ? categories_.get(s.tasks.category_id) : undefined;
        return {
          id: s.id,
          kind: "session",
          categoryId: s.tasks?.category_id ?? null,
          startsAt: s.starts_at,
          endsAt: s.ends_at,
          label: category?.name ?? "Uncategorised",
          description: s.tasks?.description ?? null,
          color: category?.effectiveColor ?? DEFAULT_COLOR,
          status: s.status,
          missed: nowMs !== null && isMissed(s, nowMs),
          done: s.status === "done",
          // A slot the server has not acknowledged has no real id yet, and a
          // skipped one is history: neither moves.
          movable: !s.id.startsWith("temp-") && s.status !== "skipped",
          byClaude: s.created_by === "claude",
          archived: false,
        };
      }),
      ...external.items,
    ],
    [items, external.items, categories_, nowMs],
  );

  const externalMinutes = useMemo(
    () =>
      googleConnected
        ? externalMinutesByCategory(externalEvents, calendarSources, weekStartDate)
        : new Map<string, number>(),
    [externalEvents, calendarSources, weekStartDate, googleConnected],
  );

  /**
   * The sessions that belong to the week on screen. The page fetches a day
   * either side as timezone padding, so `items` also holds the Sunday before
   * and the Monday after — fine for the grid, which only lays out days 0–6, but
   * every total must stick to the displayed week or the neighbours leak into
   * it. A session belongs to the day it starts on, the same rule the grid uses.
   */
  const weekItems = useMemo(
    () =>
      items.filter((s) => {
        const day = dayIndexOf(weekStartDate, new Date(s.starts_at));
        return day >= 0 && day <= 6;
      }),
    [items, weekStartDate],
  );

  /**
   * The one day the time panel is broken down for, if any. Same rules as the
   * week: a session belongs to the day it starts on, and a calendar event is
   * clipped to the day so an overnight one splits across the two.
   */
  const breakdown = useMemo(() => {
    if (breakdownDay === null) return null;
    const dayStart = addDays(weekStartDate, breakdownDay);
    return {
      dayIndex: breakdownDay,
      date: dayStart,
      sessions: weekItems.filter(
        (s) => dayIndexOf(weekStartDate, new Date(s.starts_at)) === breakdownDay,
      ),
      externalMinutes: googleConnected
        ? externalMinutesByCategory(externalEvents, calendarSources, dayStart, 1)
        : new Map<string, number>(),
    };
  }, [
    breakdownDay,
    weekStartDate,
    weekItems,
    externalEvents,
    calendarSources,
    googleConnected,
  ]);

  // Skipped slots stay on the grid as history but are not time planned.
  const totalMinutes = weekItems.filter(counts).reduce((sum, s) => sum + sessionMinutes(s), 0);

  const selected = items.find((s) => s.id === selectedId) ?? null;
  const selectedExternal = selectedId ? externalById.get(selectedId) : undefined;

  function onCreateFromDrag(payload: DragPayload, startsAt: Date) {
    const endsAt = new Date(startsAt.getTime() + payload.minutes * 60_000);
    const task = tasks.find((t) => t.id === payload.id);

    // Optimistic placeholder, drawn in full straight away — the rail already
    // knows the task. Replaced when the server round-trip lands.
    const temp: TaskSession = {
      id: `temp-${crypto.randomUUID()}`,
      task_id: payload.id,
      week_id: week.id,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: "planned",
      created_by: "app",
      tasks: {
        id: payload.id,
        category_id: payload.categoryId,
        description: payload.description,
        notes: task?.notes ?? null,
        estimated_minutes: payload.minutes,
        priority: task?.priority ?? 3,
        deadline: task?.deadline ?? null,
        status: "scheduled",
        created_at: task?.created_at ?? new Date().toISOString(),
      },
    };
    setPendingDrag(null);
    setGridError(null);
    setItems((prev) => [...prev, temp]);

    startTransition(async () => {
      const result = await placeTask({
        taskId: payload.id,
        startsAt: startsAt.toISOString(),
        minutes: payload.minutes,
      });

      // On success the action refreshes the route and the real row arrives as
      // a new prop, replacing this placeholder. On failure nothing will, so
      // take it back out rather than leaving a slot that does not exist.
      if (!result.ok) {
        setItems((prev) => prev.filter((s) => s.id !== temp.id));
        setGridError(result.error);
      }
    });
  }

  /**
   * Hiding a category hides everything under it: a parent row stands for its
   * whole subtree, so clicking it means the subtree. The set stays flat so the
   * grid can ask about a task's own leaf without walking the tree.
   */
  function onToggleCategory(id: string) {
    setHiddenCategories((prev) => {
      const next = new Set(prev);
      const subtree = subtreeIds(categories, id);
      if (prev.has(id)) for (const c of subtree) next.delete(c);
      else for (const c of subtree) next.add(c);
      return next;
    });
  }

  /**
   * A day header is a toggle for reading that day in the time panel. On the
   * one-day grid it is first the picker: tapping another day shows it (and
   * carries an open breakdown along), tapping the day already shown toggles
   * its breakdown. Either way the panel has to be on screen to be any use, so
   * a narrow layout opens it when a breakdown starts.
   */
  function onDayClick(dayIndex: number) {
    if (!wideGrid && dayIndex !== focusDay) {
      setPickedDay(dayIndex);
      if (breakdownDay !== null) setBreakdownDay(dayIndex);
      return;
    }
    const next = breakdownDay === dayIndex ? null : dayIndex;
    setBreakdownDay(next);
    if (next !== null) {
      setSelectedId(null);
      if (!wideLayout) setDrawer("detail");
    }
  }

  function onDraw(range: DrawnRange) {
    setSelectedId(null);
    setDraft(range);
  }

  /**
   * Selecting something on a narrow screen has to bring its panel with it —
   * there is no sidebar sitting there to notice the change. Deselecting closes
   * the drawer again, which is also what its own close button does.
   */
  function onSelect(id: string | null) {
    setSelectedId(id);
    if (!wideLayout) setDrawer(id ? "detail" : "none");
  }

  /**
   * Returns an error message instead of throwing it away, so a rejected insert
   * shows up in the popup rather than silently leaving the grid unchanged.
   */
  async function onDraftSubmit(choice: DraftChoice): Promise<string | null> {
    const result =
      choice.kind === "new"
        ? await createTaskOnGrid({
            categoryId: choice.categoryId,
            description: choice.description,
            startsAt: choice.startsAt.toISOString(),
            endsAt: choice.endsAt.toISOString(),
          })
        : await placeTask({
            taskId: choice.taskId,
            startsAt: choice.startsAt.toISOString(),
            endsAt: choice.endsAt.toISOString(),
          });

    if (!result.ok) return result.error;

    // No refresh here: the action already re-renders the route, and the row it
    // just wrote arrives with it.
    setDraft(null);
    return null;
  }

  /**
   * Move and resize both land here, and neither waits on the server to paint.
   * The write is fire-and-forget in the happy path; a rejection puts the slot
   * back where it was and says why.
   *
   * Moving a slot whose start has passed is a reschedule (see
   * `moveReschedules`): the server keeps the old slot as skipped and plans a
   * new one. The grid paints the move now and the refresh brings back the
   * skipped trace.
   */
  function onMove(id: string, startsAt: Date, endsAt: Date) {
    const previous = items.find((s) => s.id === id);
    if (!previous) return;

    setGridError(null);
    setItems((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() } : s,
      ),
    );

    startTransition(async () => {
      const result = await moveScheduled({
        id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      });

      if (!result.ok) {
        setItems((prev) => prev.map((s) => (s.id === id ? previous : s)));
        setGridError(result.error);
      } else if (result.rescheduled && selectedId === id) {
        // The slot that was selected is now the skipped trace; follow the task.
        setSelectedId(result.id);
      }
    });
  }

  /** Shown on the grid while dragging a slot already started: it will be rescheduled. */
  const reschedulingIds = useMemo(
    () =>
      new Set(
        nowMs === null ? [] : items.filter((s) => moveReschedules(s, nowMs)).map((s) => s.id),
      ),
    [items, nowMs],
  );

  const prevWeek = toISODate(addDays(weekStartDate, -7));
  const nextWeek = toISODate(addDays(weekStartDate, 7));

  /**
   * Both side panels are the same element at every size: a column at `xl`, and
   * below it a sheet that slides in over the grid. One instance rather than two
   * behind media queries, so the search you typed into the rail is still there
   * after you rotate the phone.
   */
  const panel = (side: "left" | "right", open: boolean) =>
    [
      "fixed inset-y-0 z-40 flex w-72 max-w-[85vw] shrink-0 flex-col bg-background shadow-2xl",
      // Visibility rides along with the transform so a closed sheet is out of
      // the tab order, but only once it has finished sliding away.
      "transition-[transform,visibility] duration-200",
      side === "left"
        ? "left-0 border-r border-line"
        : "right-0 border-l border-line",
      open
        ? "translate-x-0"
        : `invisible xl:visible ${side === "left" ? "-translate-x-full" : "translate-x-full"}`,
      // At full width it stops being a sheet: no shadow, no transform, and back
      // in the flow beside the grid.
      "xl:static xl:z-auto xl:max-w-none xl:translate-x-0 xl:shadow-none",
    ].join(" ");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CalendarLiveness connected={googleConnected} oldestSyncAt={oldestSyncAt} />
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-2 py-2 text-sm sm:px-4">
        <div className="flex items-center gap-1">
          <Link
            href={`/agenda?w=${prevWeek}`}
            className="rounded border border-line px-2 py-0.5 text-xs hover:border-accent"
          >
            ←
          </Link>
          <Link
            href="/agenda"
            className="rounded border border-line px-2 py-0.5 text-xs hover:border-accent"
          >
            Today
          </Link>
          <Link
            href={`/agenda?w=${nextWeek}`}
            className="rounded border border-line px-2 py-0.5 text-xs hover:border-accent"
          >
            →
          </Link>
        </div>
        <span className="font-medium">{fmtWeekRange(weekStartDate)}</span>
        {week.theme && (
          <span className="max-w-[40vw] truncate rounded bg-accent/10 px-2 py-0.5 text-xs text-accent">
            {week.theme}
          </span>
        )}
        {gridError && (
          <button
            type="button"
            onClick={() => setGridError(null)}
            className="max-w-full truncate rounded bg-red-500/10 px-2 py-0.5 text-xs text-red-500"
            title="Dismiss"
          >
            {gridError}
          </button>
        )}
        <span className="ml-auto flex items-center gap-2 text-xs text-muted sm:gap-3">
          {googleConnected && (
            <Link
              href="/agenda/settings"
              className="hidden tabular-nums hover:text-foreground lg:inline"
              title="Google Calendar sync status"
            >
              {googleAccount?.last_error
                ? "⚠ calendar sync failing"
                : `calendar synced ${relativeTime(oldestSyncAt)}`}
            </Link>
          )}
          <span className="tabular-nums">{fmtDuration(totalMinutes)} planned</span>

          {/* The two panels have no column below xl, so they need a way in. */}
          <button
            type="button"
            onClick={() => setDrawer("rail")}
            className="rounded border border-line px-2 py-0.5 hover:border-accent xl:hidden"
          >
            Tasks
          </button>
          <button
            type="button"
            onClick={() => setDrawer("detail")}
            className="rounded border border-line px-2 py-0.5 hover:border-accent xl:hidden"
          >
            {selected || selectedExternal ? "Details" : "Week"}
          </button>
        </span>
      </div>

      <div className="relative flex min-h-0 flex-1">
        {/* Dismisses whichever sheet is open. Never there once they are columns. */}
        {drawer !== "none" && (
          <button
            type="button"
            aria-label="Close panel"
            onClick={() => setDrawer("none")}
            className="fixed inset-0 z-30 bg-black/30 xl:hidden"
          />
        )}

        <PlannerRail
          className={panel("left", drawer === "rail")}
          onClose={() => setDrawer("none")}
          categories={categories}
          tasks={tasks}
          onDragStart={setPendingDrag}
          onDragEnd={() => setPendingDrag(null)}
        />

        <div className="min-w-0 flex-1">
          <WeekGrid
            weekStartDate={weekStartDate}
            items={gridItems}
            allDay={external.allDay}
            days={days}
            hiddenCategories={hiddenCategories}
            selectedId={selectedId}
            pendingDrag={pendingDrag}
            onSelect={onSelect}
            onCreateFromDrag={onCreateFromDrag}
            onDraw={onDraw}
            onMove={onMove}
            reschedulingIds={reschedulingIds}
            breakdownDay={breakdownDay}
            onDayClick={onDayClick}
          />
        </div>

        <aside className={panel("right", drawer === "detail")}>
          {selectedExternal ? (
            <ExternalDetail
              key={selectedId}
              event={selectedExternal.event}
              source={selectedExternal.source}
              categories={categories}
              onClose={() => onSelect(null)}
            />
          ) : selected ? (
            <SessionDetail
              key={selected.id}
              session={selected}
              categories={categories}
              now={nowMs}
              onClose={() => onSelect(null)}
            />
          ) : (
            <WeekIntent
              key={week.id}
              weekStart={weekStart}
              week={week}
              categories={categories}
              objectives={objectives}
              sessions={weekItems}
              externalMinutes={externalMinutes}
              breakdown={breakdown}
              onClearBreakdown={() => setBreakdownDay(null)}
              hiddenCategories={hiddenCategories}
              onToggleCategory={onToggleCategory}
              onShowAllCategories={() => setHiddenCategories(new Set())}
              onClose={() => setDrawer("none")}
            />
          )}
        </aside>
      </div>

      {draft && (
        <SessionPopup
          draft={draft}
          categories={categories}
          tasks={tasks}
          onCancel={() => setDraft(null)}
          onSubmit={onDraftSubmit}
        />
      )}
    </div>
  );
}
