"use client";

import { useState, useTransition } from "react";
import { buildTree, flattenTree } from "@/lib/categories";
import { fmtDuration, fmtTime, minutesOfDay } from "@/lib/time";
import type { Category, ScheduledBlock } from "@/lib/types";
import {
  deleteScheduled,
  detachTask,
  updateScheduled,
} from "@/server/actions/schedule";

type Props = {
  block: ScheduledBlock;
  categories: Category[];
  onClose: () => void;
};

export function BlockDetail({ block, categories, onClose }: Props) {
  const [title, setTitle] = useState(block.title);
  const [pending, startTransition] = useTransition();

  const flat = flattenTree(buildTree(categories));
  const start = new Date(block.starts_at);
  const end = new Date(block.ends_at);
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);

  const commit = (fn: () => Promise<unknown>) => startTransition(() => void fn());

  return (
    <div className="flex h-full flex-col gap-3 p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium">Block</span>
        <button onClick={onClose} className="text-muted hover:text-foreground">
          Close
        </button>
      </div>

      <div className="tabular-nums text-muted">
        {start.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}
        {" · "}
        {fmtTime(minutesOfDay(start))}–{fmtTime(minutesOfDay(end))} ({fmtDuration(minutes)})
      </div>

      <label className="block">
        <span className="text-muted">Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title !== block.title) commit(() => updateScheduled({ id: block.id, title }));
          }}
          className="mt-1 w-full rounded border border-line bg-surface px-2 py-1 outline-none focus:border-accent"
        />
      </label>

      <label className="block">
        <span className="text-muted">Category</span>
        <select
          value={block.category_id ?? ""}
          onChange={(e) =>
            commit(() =>
              updateScheduled({ id: block.id, categoryId: e.target.value || null }),
            )
          }
          className="mt-1 w-full rounded border border-line bg-surface px-2 py-1 outline-none focus:border-accent"
        >
          <option value="">No category</option>
          {flat.map((c) => (
            <option key={c.id} value={c.id}>
              {"— ".repeat(c.depth)}
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <div>
        <span className="text-muted">Status</span>
        <div className="mt-1 flex gap-1">
          {(["planned", "done", "skipped"] as const).map((s) => (
            <button
              key={s}
              onClick={() => commit(() => updateScheduled({ id: block.id, status: s }))}
              className={`flex-1 rounded border px-2 py-1 capitalize ${
                block.status === s
                  ? "border-accent bg-accent/10 text-foreground"
                  : "border-line text-muted hover:text-foreground"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {block.scheduled_block_tasks.length > 0 && (
        <div>
          <span className="text-muted">Tasks in this block</span>
          <ul className="mt-1 space-y-1">
            {block.scheduled_block_tasks.map((link) => (
              <li
                key={link.task_id}
                className="flex items-center gap-2 rounded border border-line bg-surface px-2 py-1"
              >
                <span className="flex-1 truncate">{link.tasks?.title ?? "Task"}</span>
                <span className="tabular-nums text-muted">
                  {fmtDuration(link.planned_minutes)}
                </span>
                <button
                  onClick={() =>
                    commit(() =>
                      detachTask({
                        scheduledBlockId: block.id,
                        taskId: link.task_id,
                      }),
                    )
                  }
                  className="text-muted hover:text-red-500"
                  title="Return to backlog"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        onClick={() => {
          onClose();
          commit(() => deleteScheduled(block.id));
        }}
        disabled={pending}
        className="mt-auto rounded border border-line px-2 py-1.5 text-red-500 hover:border-red-500 disabled:opacity-50"
      >
        Remove from week
      </button>
    </div>
  );
}
