"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { categoryIndex, subtreeIds, DEFAULT_COLOR } from "@/lib/categories";
import {
  addDays,
  fmtDuration,
  fmtWeekRange,
  fromISODate,
  toISODate,
} from "@/lib/time";
import type {
  AllDayItem,
  Block,
  CalendarSource,
  Category,
  DragPayload,
  ExternalEvent,
  GoogleAccount,
  GridItem,
  Objective,
  ScheduledBlock,
  Task,
  Week,
} from "@/lib/types";
import { externalItems, externalMinutesByCategory } from "@/lib/external";
import { blockChildren, blockMinutes, childMinutes } from "@/lib/blocks";
import { CalendarLiveness } from "./CalendarLiveness";
import { ExternalDetail } from "./ExternalDetail";
import {
  createScheduledBlock,
  moveScheduled,
  placeBlock,
  placeTask,
} from "@/server/actions/schedule";
import { BlockPopup, type DraftBlock } from "./BlockPopup";
import { relativeTime } from "./GoogleConnection";
import { BlockDetail } from "./BlockDetail";
import { PlannerRail } from "./PlannerRail";
import { WeekGrid, type DrawnRange } from "./WeekGrid";
import { WeekIntent } from "./WeekIntent";

type Props = {
  weekStart: string;
  week: Week;
  categories: Category[];
  tasks: Task[];
  blocks: Block[];
  scheduled: ScheduledBlock[];
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
  blocks,
  scheduled,
  objectives,
  externalEvents,
  calendarSources,
  googleAccount,
  oldestSyncAt,
}: Props) {
  const weekStartDate = useMemo(() => fromISODate(weekStart), [weekStart]);

  /**
   * The grid owns the placed blocks between server renders.
   *
   * This used to be `useOptimistic` over the `scheduled` prop, which meant
   * every drag had to be followed by a route re-render: as soon as the action
   * settled React dropped the optimistic value and fell back to the prop, so
   * without a refresh the block snapped back to where it started. Holding the
   * list in real state lets a move persist on the strength of the write alone.
   *
   * The prop is still the source of truth whenever the server sends a new one —
   * a week navigation, or any action that does refresh — so it re-seeds on a
   * new prop identity. Adjusting state during render is the documented way to
   * do that; an effect would paint the stale list first.
   */
  const [items, setItems] = useState<ScheduledBlock[]>(scheduled);
  const [seededFrom, setSeededFrom] = useState(scheduled);
  if (seededFrom !== scheduled) {
    setSeededFrom(scheduled);
    setItems(scheduled);
  }

  const [pendingDrag, setPendingDrag] = useState<DragPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftBlock | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  /**
   * Categories the week is currently being read without. Nothing but a lens:
   * it is never written anywhere, and it survives no reload — hiding a category
   * asks "what does the week look like without this", it does not change it.
   *
   * Held here rather than in the panel that toggles it, because the panel is
   * unmounted whenever a block is selected and the grid must keep reading it.
   */
  const [hiddenCategories, setHiddenCategories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [, startTransition] = useTransition();

  const googleConnected = Boolean(googleAccount && !googleAccount.disconnected_at);

  const categories_ = useMemo(() => categoryIndex(categories), [categories]);
  const blockById = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks]);

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
    for (const item of external.items) {
      const [sourceId, eventId] = item.id.split(":");
      const source = sources.get(sourceId);
      const event = externalEvents.find(
        (e) => e.calendar_source_id === sourceId && e.external_event_id === eventId,
      );
      if (source && event) out.set(item.id, { event, source });
    }
    return out;
  }, [external.items, externalEvents, calendarSources]);

  /**
   * A block has no category and no title of its own. A placed template keeps
   * the name you gave it; otherwise the only thing the block says about itself
   * is its description. Either can be empty — the tasks inside carry the
   * labels, and the grid draws the block as the outline around them.
   */
  const labelFor = (block: ScheduledBlock) => {
    if (block.source_block_id) {
      const source = blockById.get(block.source_block_id);
      if (source) return source.name;
    }
    return block.description ?? "";
  };

  /**
   * The outline's colour. With no category to borrow from, a block takes the
   * template's colour if it came from one, and otherwise stays neutral so the
   * children are the only thing carrying category colour.
   */
  const colorFor = (block: ScheduledBlock) => {
    if (block.source_block_id) {
      const source = blockById.get(block.source_block_id);
      if (source?.color) return source.color;
    }
    return DEFAULT_COLOR;
  };

  /**
   * One list for the grid. Own blocks and external events are stored apart —
   * the mirror is read-only and carries no category of its own — but they lay
   * out together, so they are normalised here.
   */
  const gridItems: GridItem[] = useMemo(
    () => [
      ...items.map((block) => {
        const children = blockChildren(block, categories_);
        return {
          id: block.id,
          kind: "block" as const,
          // A block has no category of its own; its children carry them.
          categoryId: null,
          startsAt: block.starts_at,
          endsAt: block.ends_at,
          label: labelFor(block),
          description: block.description,
          color: colorFor(block),
          done: block.status === "done",
          // A block the server has not acknowledged has no real id yet, so a
          // move would address a row that does not exist.
          movable: !block.id.startsWith("temp-"),
          children,
          overfilled: childMinutes(block) > blockMinutes(block),
          // Only a mirrored event can be an archive. A block you drew is yours
          // already, and nothing outside the app can delete it.
          archived: false,
        };
      }),
      ...external.items,
    ],
    // labelFor/colorFor read the same memoised maps these depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, external.items, categories_, blockById],
  );

  const externalMinutes = useMemo(
    () =>
      googleConnected
        ? externalMinutesByCategory(externalEvents, calendarSources, weekStartDate)
        : new Map<string, number>(),
    [externalEvents, calendarSources, weekStartDate, googleConnected],
  );

  const totalMinutes = items.reduce(
    (sum, b) =>
      sum +
      Math.round(
        (new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 60_000,
      ),
    0,
  );

  const selected = items.find((b) => b.id === selectedId) ?? null;
  const selectedExternal = selectedId ? externalById.get(selectedId) : undefined;

  function onCreateFromDrag(payload: DragPayload, startsAt: Date) {
    const endsAt = new Date(startsAt.getTime() + payload.minutes * 60_000);

    // Optimistic placeholder; replaced when the server round-trip lands.
    //
    // A dragged task can be drawn in full straight away — the rail already knows
    // its category and minutes. A template cannot: its steps live on the server,
    // so the block appears empty for one round trip and fills in on the refresh.
    const temp: ScheduledBlock = {
      id: `temp-${crypto.randomUUID()}`,
      week_id: week.id,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      description: null,
      source_block_id: payload.kind === "block" ? payload.id : null,
      status: "planned",
      actual_minutes: null,
      scheduled_block_tasks:
        payload.kind === "task"
          ? [
              {
                task_id: payload.id,
                planned_minutes: payload.minutes,
                position: 0,
                tasks: {
                  id: payload.id,
                  description: payload.description,
                  category_id: payload.categoryId,
                  estimated_minutes: payload.minutes,
                  ad_hoc: false,
                },
              },
            ]
          : [],
    };
    setPendingDrag(null);
    setGridError(null);
    setItems((prev) => [...prev, temp]);

    startTransition(async () => {
      const result =
        payload.kind === "task"
          ? await placeTask({
              weekStart,
              taskId: payload.id,
              startsAt: startsAt.toISOString(),
              minutes: payload.minutes,
            })
          : await placeBlock({
              weekStart,
              blockId: payload.id,
              startsAt: startsAt.toISOString(),
            });

      // On success the action refreshes the route and the real row arrives as
      // a new prop, replacing this placeholder. On failure nothing will, so
      // take it back out rather than leaving a block that does not exist.
      if (!result.ok) {
        setItems((prev) => prev.filter((b) => b.id !== temp.id));
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

  function onDraw(range: DrawnRange) {
    setSelectedId(null);
    setDraft(range);
  }

  /**
   * Returns an error message instead of throwing it away, so a rejected insert
   * shows up in the popup rather than silently leaving the grid unchanged.
   */
  async function onDraftSubmit(input: {
    categoryId: string;
    description: string | null;
    startsAt: Date;
    endsAt: Date;
  }): Promise<string | null> {
    const result = await createScheduledBlock({
      weekStart,
      categoryId: input.categoryId,
      description: input.description,
      startsAt: input.startsAt.toISOString(),
      endsAt: input.endsAt.toISOString(),
    });

    if (!result.ok) return result.error;

    // No refresh here: the action already re-renders the route, and the row it
    // just wrote arrives with it.
    setDraft(null);
    return null;
  }

  /**
   * Move and resize both land here, and neither waits on the server to paint.
   * The write is fire-and-forget in the happy path; a rejection puts the block
   * back where it was and says why.
   */
  function onMove(id: string, startsAt: Date, endsAt: Date) {
    const previous = items.find((b) => b.id === id);
    if (!previous) return;

    setGridError(null);
    setItems((prev) =>
      prev.map((b) =>
        b.id === id
          ? { ...b, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() }
          : b,
      ),
    );

    startTransition(async () => {
      const result = await moveScheduled({
        id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      });

      if (!result.ok) {
        setItems((prev) => prev.map((b) => (b.id === id ? previous : b)));
        setGridError(result.error);
      }
    });
  }

  const prevWeek = toISODate(addDays(weekStartDate, -7));
  const nextWeek = toISODate(addDays(weekStartDate, 7));

  return (
    <div className="flex h-[calc(100vh-49px)] flex-col">
      <CalendarLiveness connected={googleConnected} oldestSyncAt={oldestSyncAt} />
      <div className="flex items-center gap-3 border-b border-line px-4 py-2 text-sm">
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
          <span className="rounded bg-accent/10 px-2 py-0.5 text-xs text-accent">
            {week.theme}
          </span>
        )}
        {gridError && (
          <button
            type="button"
            onClick={() => setGridError(null)}
            className="rounded bg-red-500/10 px-2 py-0.5 text-xs text-red-500"
            title="Dismiss"
          >
            {gridError}
          </button>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-muted">
          {googleConnected && (
            <Link
              href="/agenda/settings"
              className="tabular-nums hover:text-foreground"
              title="Google Calendar sync status"
            >
              {googleAccount?.last_error
                ? "⚠ calendar sync failing"
                : `calendar synced ${relativeTime(oldestSyncAt)}`}
            </Link>
          )}
          <span className="tabular-nums">{fmtDuration(totalMinutes)} planned</span>
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <PlannerRail
          categories={categories}
          tasks={tasks}
          blocks={blocks}
          onDragStart={setPendingDrag}
          onDragEnd={() => setPendingDrag(null)}
        />

        <div className="min-w-0 flex-1">
          <WeekGrid
            weekStartDate={weekStartDate}
            items={gridItems}
            allDay={external.allDay}
            hiddenCategories={hiddenCategories}
            selectedId={selectedId}
            pendingDrag={pendingDrag}
            onSelect={setSelectedId}
            onCreateFromDrag={onCreateFromDrag}
            onDraw={onDraw}
            onMove={onMove}
          />
        </div>

        <aside className="w-72 shrink-0 border-l border-line">
          {selectedExternal ? (
            <ExternalDetail
              key={selectedId}
              event={selectedExternal.event}
              source={selectedExternal.source}
              categories={categories}
              onClose={() => setSelectedId(null)}
            />
          ) : selected ? (
            <BlockDetail
              key={selected.id}
              block={selected}
              categories={categories}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <WeekIntent
              key={week.id}
              weekStart={weekStart}
              week={week}
              categories={categories}
              objectives={objectives}
              scheduled={items}
              externalMinutes={externalMinutes}
              hiddenCategories={hiddenCategories}
              onToggleCategory={onToggleCategory}
              onShowAllCategories={() => setHiddenCategories(new Set())}
            />
          )}
        </aside>
      </div>

      {draft && (
        <BlockPopup
          draft={draft}
          categories={categories}
          defaultCategoryId={null}
          onCancel={() => setDraft(null)}
          onSubmit={onDraftSubmit}
        />
      )}
    </div>
  );
}
