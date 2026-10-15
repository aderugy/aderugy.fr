"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Markdown } from "@/components/ui/Markdown";
import { SessionInterview } from "@/components/jobs/SessionInterview";
import { categoryIndex, DEFAULT_COLOR } from "@/lib/categories";
import { canUnschedule, isMissed, sessionMinutes } from "@/lib/agenda/sessions";
import { fmtDuration, fmtTime, minutesOfDay, toISODate } from "@/lib/time";
import type { Category, SessionStatus, TaskSession } from "@/lib/types";
import {
  deleteSlot,
  moveScheduled,
  rescheduleSession,
  setSlotStatus,
  slotToBacklog,
  taskHistory,
} from "@/server/actions/schedule";
import { updateTask } from "@/server/actions/tasks";
import { TaskEditor } from "./backlog/TaskEditor";
import type { BacklogTask } from "./backlog/shared";

type Props = {
  session: TaskSession;
  categories: Category[];
  /** The current minute, or null before the client has taken over. */
  now: number | null;
  onClose: () => void;
};

type HistoryRow = { id: string; starts_at: string; ends_at: string; status: SessionStatus; created_by: "app" | "claude" };

const STATUS_LABEL: Record<SessionStatus | "missed", string> = {
  planned: "Planned",
  done: "Done",
  skipped: "Skipped",
  missed: "Missed",
};

function fmtDay(d: Date) {
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function fmtSpan(startsAt: string, endsAt: string) {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  return `${fmtDay(s)} · ${fmtTime(minutesOfDay(s))}–${fmtTime(minutesOfDay(e))}`;
}

/**
 * A slot on the grid, which is its task: what it is, what happened to it, and
 * what to do with it. Done, skip and reschedule keep the slot as history;
 * only a slot that has not started can leave the grid without a trace.
 */
export function SessionDetail({ session, categories, now, onClose }: Props) {
  const task = session.tasks;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(task?.description ?? "");
  const [rescheduling, setRescheduling] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);

  const index = useMemo(() => categoryIndex(categories), [categories]);
  const category = task ? index.get(task.category_id) : undefined;

  const start = new Date(session.starts_at);
  const end = new Date(session.ends_at);
  const minutes = sessionMinutes(session);
  const temp = session.id.startsWith("temp-");
  const missed = now !== null && isMissed(session, now);
  const notStarted = now !== null && canUnschedule(session, now);
  const state: SessionStatus | "missed" = missed ? "missed" : session.status;

  // The task's other slots. Read once per session opened; the week page does
  // not hold them, since they can sit in any week.
  useEffect(() => {
    if (!task || temp) return;
    let live = true;
    taskHistory(task.id).then((r) => {
      // Unreadable history shows as none rather than loading forever.
      if (live) setHistory(r.ok ? r.sessions : []);
    });
    return () => {
      live = false;
    };
  }, [task, temp, session.status, session.starts_at]);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Something went wrong");
      else after?.();
    });
  }

  if (!task) {
    return (
      <div className="p-3 text-xs text-muted">
        This slot&apos;s task is gone.{" "}
        <button onClick={onClose} className="underline">
          Close
        </button>
      </div>
    );
  }

  const others = (history ?? []).filter((h) => h.id !== session.id);
  const skippedBefore = others.filter((h) => h.status === "skipped").length;

  const asBacklogTask: BacklogTask = {
    ...task,
    splittable: true,
    ad_hoc: false,
    completed_at: null,
    scheduled_at: session.status === "planned" ? session.starts_at : null,
    scheduled_label: session.status === "planned" ? fmtSpan(session.starts_at, session.ends_at) : null,
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium">Task</span>
        <button onClick={onClose} className="text-muted hover:text-foreground">
          Close
        </button>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="tabular-nums text-muted">
          {start.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}
          {" · "}
          {fmtTime(minutesOfDay(start))}–{fmtTime(minutesOfDay(end))} ({fmtDuration(minutes)})
        </span>
        <span
          className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
            state === "missed"
              ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
              : state === "done"
                ? "bg-green-600/15 text-green-700 dark:text-green-400"
                : state === "skipped"
                  ? "bg-line text-muted"
                  : "bg-accent/10 text-accent"
          }`}
        >
          {STATUS_LABEL[state]}
        </span>
      </div>
      {session.created_by === "claude" && <p className="-mt-2 text-[10px] text-muted">✦ Planned by Claude</p>}

      {session.interview && <SessionInterview interview={session.interview} />}

      <div className="rounded border border-line bg-surface p-2" style={{ borderLeft: `3px solid ${category?.effectiveColor ?? DEFAULT_COLOR}` }}>
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-medium" title={category?.path}>
            {category?.name ?? "Uncategorised"}
          </span>
          <span className="shrink-0 tabular-nums text-muted" title="The task's estimate">
            est. {fmtDuration(task.estimated_minutes)}
          </span>
        </div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => {
            if (description.trim() !== (task.description ?? "")) {
              run(() => updateTask({ id: task.id, description: description.trim() || null }));
            }
          }}
          rows={2}
          placeholder="What this task is"
          className="mt-1 w-full resize-none rounded border border-line bg-background px-2 py-1 outline-none focus:border-accent"
        />
        {task.notes && (
          <details className="mt-1" open>
            <summary className="cursor-pointer text-[10px] text-muted hover:text-foreground">Notes</summary>
            <Markdown source={task.notes} className="mt-1 text-xs" />
          </details>
        )}
        <button
          onClick={() => setEditing(true)}
          disabled={temp}
          className="mt-1 text-[11px] text-muted underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
        >
          Edit task…
        </button>
      </div>

      {/* What can happen to this slot depends on where the clock is. */}
      {session.status === "planned" && (
        <div className="grid grid-cols-2 gap-1">
          <button
            onClick={() => run(() => setSlotStatus({ id: session.id, status: "done" }))}
            disabled={pending || temp}
            className="rounded bg-accent px-2 py-1.5 font-medium text-white disabled:opacity-60"
          >
            ✓ Done
          </button>
          <button
            onClick={() => run(() => slotToBacklog(session.id), notStarted ? onClose : undefined)}
            disabled={pending || temp}
            title={
              notStarted
                ? "Take it off the grid. It has not started, so nothing is kept."
                : "Skip it: the slot stays here as history, and the task goes back to the backlog."
            }
            className="rounded border border-line px-2 py-1.5 hover:border-accent disabled:opacity-60"
          >
            {notStarted ? "Back to backlog" : "Skip → backlog"}
          </button>
        </div>
      )}

      {session.status === "done" && (
        <button
          onClick={() => run(() => setSlotStatus({ id: session.id, status: "planned" }))}
          disabled={pending}
          className="rounded border border-line px-2 py-1.5 hover:border-accent disabled:opacity-60"
          title="Not done after all: the slot goes back to planned, and the task is reopened."
        >
          Undo done
        </button>
      )}

      {session.status === "skipped" && (
        <p className="text-muted">
          Skipped: kept here as history. The task is back in the backlog
          {task.status === "scheduled" ? " — and already planned again." : "."}
        </p>
      )}

      {!temp && (session.status !== "skipped" || task.status === "backlog") && (
        <Reschedule
          open={rescheduling}
          onOpen={() => setRescheduling(true)}
          onCancel={() => setRescheduling(false)}
          label={session.status === "planned" ? (notStarted ? "Move to…" : "Reschedule…") : "Plan again…"}
          hint={
            session.status === "planned" && !notStarted
              ? "This slot stays as skipped; the task is planned at the new time."
              : session.status !== "planned"
                ? "A new slot for the same task; this one stays as it is."
                : null
          }
          start={start}
          minutes={minutes}
          pending={pending}
          onSubmit={(startsAt, endsAt) => {
            const span = { id: session.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
            run(
              // A slot that has not started just moves; anything else keeps
              // its trace and gets a new slot.
              () => (session.status === "planned" && notStarted ? moveScheduled(span) : rescheduleSession(span)),
              () => {
                setRescheduling(false);
                onClose();
                // A plain move does not refresh on its own (the grid usually
                // drew it already); from here, nothing did.
                router.refresh();
              },
            );
          }}
        />
      )}

      {error && <p className="text-red-500">{error}</p>}

      <div>
        <span className="text-muted">
          History{skippedBefore > 0 ? ` · skipped ${skippedBefore}×` : ""}
        </span>
        {history === null ? (
          <p className="mt-1 text-muted">…</p>
        ) : others.length === 0 ? (
          <p className="mt-1 text-muted">No other slot for this task.</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {others.map((h) => {
              const hMissed = now !== null && isMissed(h, now);
              return (
                <li key={h.id} className="flex items-baseline gap-2 tabular-nums">
                  <span className={h.status === "skipped" ? "text-muted line-through" : ""}>
                    {fmtSpan(h.starts_at, h.ends_at)}
                  </span>
                  <span className={`ml-auto shrink-0 ${hMissed ? "text-amber-600" : "text-muted"}`}>
                    {STATUS_LABEL[hMissed ? "missed" : h.status]}
                    {h.created_by === "claude" ? " ✦" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-auto pt-2">
        {confirmDelete ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-muted">Delete this slot? The task stays.</span>
            <button onClick={() => setConfirmDelete(false)} className="text-muted hover:text-foreground">
              Cancel
            </button>
            <button
              onClick={() => run(() => deleteSlot(session.id), onClose)}
              disabled={pending}
              className="rounded border border-red-500 px-2 py-1 text-red-500 disabled:opacity-60"
            >
              Delete
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            disabled={temp}
            className="text-[11px] text-muted hover:text-red-500 disabled:opacity-50"
            title="Remove the slot from the grid and from the task's history"
          >
            Delete slot
          </button>
        )}
      </div>

      {editing && (
        <TaskEditor
          task={asBacklogTask}
          categories={categories}
          today={now !== null ? toISODate(new Date(now)) : toISODate(new Date(session.starts_at))}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            run(() => setSlotStatus({ id: session.id, status: "done" }));
          }}
        />
      )}
    </div>
  );
}

/** A new time for the task: a day and a start, keeping the slot's length unless changed. */
function Reschedule({
  open,
  onOpen,
  onCancel,
  label,
  hint,
  start,
  minutes,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpen: () => void;
  onCancel: () => void;
  label: string;
  hint: string | null;
  start: Date;
  minutes: number;
  pending: boolean;
  onSubmit: (startsAt: Date, endsAt: Date) => void;
}) {
  const [day, setDay] = useState(() => toISODate(start));
  const [time, setTime] = useState(() => fmtTime(minutesOfDay(start)));
  const [length, setLength] = useState(String(minutes));
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        onClick={onOpen}
        className="rounded border border-dashed border-line px-2 py-1.5 text-muted hover:border-accent hover:text-foreground"
      >
        {label}
      </button>
    );
  }

  return (
    <form
      className="space-y-1 rounded border border-line p-2"
      onSubmit={(e) => {
        e.preventDefault();
        const m = Math.round(Number(length));
        const startsAt = new Date(`${day}T${time}`);
        if (Number.isNaN(startsAt.getTime())) return setError("Pick a day and a time.");
        if (!Number.isFinite(m) || m < 5 || m > 24 * 60) return setError("Between 5 minutes and 24 hours.");
        setError(null);
        onSubmit(startsAt, new Date(startsAt.getTime() + m * 60_000));
      }}
    >
      <div className="flex gap-1">
        <input
          type="date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
          className="min-w-0 flex-1 rounded border border-line bg-surface px-1 py-1 outline-none focus:border-accent"
        />
        <input
          type="time"
          step={900}
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className="w-20 rounded border border-line bg-surface px-1 py-1 tabular-nums outline-none focus:border-accent"
        />
      </div>
      <div className="flex items-center gap-1">
        <input
          value={length}
          onChange={(e) => setLength(e.target.value)}
          inputMode="numeric"
          className="w-14 rounded border border-line bg-surface px-1 py-1 text-right tabular-nums outline-none focus:border-accent"
        />
        <span className="text-muted">min</span>
        <button type="button" onClick={onCancel} className="ml-auto px-2 py-1 text-muted hover:text-foreground">
          Cancel
        </button>
        <button type="submit" disabled={pending} className="rounded bg-accent px-3 py-1 font-medium text-white disabled:opacity-60">
          Plan
        </button>
      </div>
      {hint && <p className="text-[10px] text-muted">{hint}</p>}
      {error && <p className="text-red-500">{error}</p>}
    </form>
  );
}
