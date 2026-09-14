"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useOptimistic, useState, useTransition } from "react";
import { categoryIndex, DEFAULT_COLOR } from "@/lib/categories";
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

type OptimisticAction =
  | { type: "add"; block: ScheduledBlock }
  | { type: "move"; id: string; startsAt: string; endsAt: string };

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
  const router = useRouter();
  const weekStartDate = useMemo(() => fromISODate(weekStart), [weekStart]);

  // Drags feel instant because the grid renders the optimistic view; when the
  // server action settles, React drops back to the revalidated props.
  const [items, applyOptimistic] = useOptimistic(
    scheduled,
    (state: ScheduledBlock[], action: OptimisticAction) => {
      switch (action.type) {
        case "add":
          return [...state, action.block];
        case "move":
          return state.map((b) =>
            b.id === action.id
              ? { ...b, starts_at: action.startsAt, ends_at: action.endsAt }
              : b,
          );
      }
    },
  );

  const [pendingDrag, setPendingDrag] = useState<DragPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftBlock | null>(null);
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
   * Blocks have no title. A placed template keeps the name you gave it — it
   * spans categories, so collapsing it to one would lose what you chose.
   * Everything else reads as its category's leaf name.
   */
  const labelFor = (block: ScheduledBlock) => {
    if (block.source_block_id) {
      const source = blockById.get(block.source_block_id);
      if (source) return source.name;
    }
    return categories_.get(block.category_id)?.name ?? "Uncategorised";
  };

  const colorFor = (block: ScheduledBlock) => {
    const category = categories_.get(block.category_id);
    if (category) return category.effectiveColor;
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
      ...items.map((block) => ({
        id: block.id,
        kind: "block" as const,
        startsAt: block.starts_at,
        endsAt: block.ends_at,
        label: labelFor(block),
        description: block.description,
        color: colorFor(block),
        done: block.status === "done",
        movable: true,
      })),
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
    const temp: ScheduledBlock = {
      id: `temp-${crypto.randomUUID()}`,
      week_id: week.id,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      description: payload.kind === "task" ? payload.label : null,
      category_id: payload.categoryId,
      source_block_id: payload.kind === "block" ? payload.id : null,
      status: "planned",
      actual_minutes: null,
      scheduled_block_tasks: [],
    };
    setPendingDrag(null);

    startTransition(async () => {
      applyOptimistic({ type: "add", block: temp });
      if (payload.kind === "task") {
        await placeTask({
          weekStart,
          taskId: payload.id,
          startsAt: startsAt.toISOString(),
          minutes: payload.minutes,
        });
      } else {
        await placeBlock({
          weekStart,
          blockId: payload.id,
          startsAt: startsAt.toISOString(),
        });
      }
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

    setDraft(null);
    router.refresh();
    return null;
  }

  function onMove(id: string, startsAt: Date, endsAt: Date) {
    startTransition(async () => {
      applyOptimistic({
        type: "move",
        id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      });
      await moveScheduled({
        id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      });
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
