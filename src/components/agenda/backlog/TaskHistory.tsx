"use client";

import { useEffect, useState } from "react";
import { fmtTime, minutesOfDay } from "@/lib/time";
import type { SessionStatus } from "@/lib/types";
import { taskHistory } from "@/server/actions/schedule";

type Row = { id: string; starts_at: string; ends_at: string; status: SessionStatus; created_by: "app" | "claude" };

const LABEL: Record<SessionStatus | "missed", string> = {
  planned: "planned",
  done: "done",
  skipped: "skipped",
  missed: "missed",
};

/**
 * Every slot this task has had on the grid, newest first: when it was
 * planned and what became of it. Skipped attempts stay here after the task
 * went back to the backlog, which is the trace a reschedule leaves.
 */
export function TaskHistory({ taskId }: { taskId: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  // Read once, when the editor opens; "now" is fixed at that moment too.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    taskHistory(taskId).then((r) => {
      if (live) setRows(r.ok ? r.sessions : []);
    });
    return () => {
      live = false;
    };
  }, [taskId]);

  if (!rows || rows.length === 0) return null;

  return (
    <div className="text-xs">
      <div className="mb-1 font-medium text-muted">History</div>
      <ul className="space-y-0.5">
        {rows.map((r) => {
          const s = new Date(r.starts_at);
          const e = new Date(r.ends_at);
          const state = r.status === "planned" && e.getTime() <= now ? "missed" : r.status;
          return (
            <li key={r.id} className="flex items-baseline gap-2 tabular-nums">
              <span className={state === "skipped" ? "text-muted line-through" : ""}>
                {s.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}{" "}
                {fmtTime(minutesOfDay(s))}–{fmtTime(minutesOfDay(e))}
              </span>
              <span className={`ml-auto ${state === "missed" ? "text-amber-600" : "text-muted"}`}>
                {LABEL[state]}
                {r.created_by === "claude" ? " ✦" : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
