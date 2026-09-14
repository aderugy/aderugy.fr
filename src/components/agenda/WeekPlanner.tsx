"use client";

import Link from "next/link";
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
  Block,
  Category,
  DragPayload,
  ExternalEvent,
  GoogleAccount,
  Objective,
  ScheduledBlock,
  Task,
  Week,
} from "@/lib/types";
import { DEFAULT_BUSY_PREFERENCES, busySegments } from "@/lib/busy";
import { CalendarLiveness } from "./CalendarLiveness";
import {
  moveScheduled,
  placeAdhoc,
  placeBlock,
  placeTask,
} from "@/server/actions/schedule";
import { relativeTime } from "./GoogleConnection";
import { BlockDetail } from "./BlockDetail";
import { PlannerRail } from "./PlannerRail";
import { WeekGrid } from "./WeekGrid";
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
  googleAccount,
  oldestSyncAt,
}: Props) {
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
  const [, startTransition] = useTransition();

  const googleConnected = Boolean(googleAccount && !googleAccount.disconnected_at);

  const busy = useMemo(
    () =>
      googleConnected
        ? busySegments(externalEvents, weekStartDate, {
            ...DEFAULT_BUSY_PREFERENCES,
            busyCalendarIds: googleAccount?.busy_calendar_ids ?? [],
          })
        : [],
    [externalEvents, weekStartDate, googleConnected, googleAccount],
  );

  const categories_ = useMemo(() => categoryIndex(categories), [categories]);
  const blockById = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks]);

  const colorFor = (block: ScheduledBlock) => {
    if (block.category_id) {
      const category = categories_.get(block.category_id);
      if (category) return category.effectiveColor;
    }
    if (block.source_block_id) {
      const source = blockById.get(block.source_block_id);
      if (source?.color) return source.color;
    }
    return DEFAULT_COLOR;
  };

  const totalMinutes = items.reduce(
    (sum, b) =>
      sum +
      Math.round(
        (new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 60_000,
      ),
    0,
  );

  const selected = items.find((b) => b.id === selectedId) ?? null;

  function onCreateFromDrag(payload: DragPayload, startsAt: Date) {
    const endsAt = new Date(startsAt.getTime() + payload.minutes * 60_000);

    // Optimistic placeholder; replaced when the server round-trip lands.
    const temp: ScheduledBlock = {
      id: `temp-${crypto.randomUUID()}`,
      week_id: week.id,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      title: payload.title,
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

  function onCreateAdhoc(startsAt: Date, minutes: number) {
    startTransition(async () => {
      await placeAdhoc({
        weekStart,
        title: "New block",
        startsAt: startsAt.toISOString(),
        minutes,
        categoryId: null,
      });
    });
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
            blocks={items}
            colorFor={colorFor}
            selectedId={selectedId}
            pendingDrag={pendingDrag}
            busy={busy}
            onSelect={setSelectedId}
            onCreateFromDrag={onCreateFromDrag}
            onCreateAdhoc={onCreateAdhoc}
            onMove={onMove}
          />
        </div>

        <aside className="w-72 shrink-0 border-l border-line">
          {selected ? (
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
            />
          )}
        </aside>
      </div>
    </div>
  );
}
