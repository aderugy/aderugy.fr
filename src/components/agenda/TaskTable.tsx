"use client";

import { useMemo, useState, useTransition } from "react";
import { buildTree, flattenTree, DEFAULT_COLOR } from "@/lib/categories";
import { CategoryPicker } from "./CategoryPicker";
import { fmtDuration } from "@/lib/time";
import { PRIORITY_LABELS, type Category, type Task } from "@/lib/types";
import { createTask, deleteTask, updateTask } from "@/server/actions/tasks";

export function TaskTable({
  categories,
  tasks,
}: {
  categories: Category[];
  tasks: Task[];
}) {
  const flat = useMemo(() => flattenTree(buildTree(categories)), [categories]);
  const byId = useMemo(() => new Map(flat.map((c) => [c.id, c])), [flat]);
  const [showScheduled, setShowScheduled] = useState(true);

  const visible = tasks.filter((t) => showScheduled || t.status === "backlog");

  return (
    <div className="text-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">Tasks</h2>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input
            type="checkbox"
            checked={showScheduled}
            onChange={(e) => setShowScheduled(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Show scheduled
        </label>
      </div>

      <NewTaskForm categories={categories} />

      <ul className="mt-3 space-y-1">
        {visible.length === 0 && (
          <li className="py-6 text-center text-xs text-muted">No tasks yet.</li>
        )}
        {visible.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            categories={categories}
            color={
              task.category_id
                ? (byId.get(task.category_id)?.effectiveColor ?? DEFAULT_COLOR)
                : DEFAULT_COLOR
            }
          />
        ))}
      </ul>
    </div>
  );
}

function TaskRow({
  task,
  categories,
  color,
}: {
  task: Task;
  categories: Category[];
  color: string;
}) {
  const [description, setDescription] = useState(task.description ?? "");
  const [, startTransition] = useTransition();
  const commit = (fn: () => Promise<unknown>) => startTransition(() => void fn());

  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded border border-line bg-surface px-2 py-1.5"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <div className="w-44 shrink-0 max-sm:w-full">
        <CategoryPicker
          categories={categories}
          value={task.category_id}
          onChange={(id) => commit(() => updateTask({ id: task.id, categoryId: id }))}
        />
      </div>

      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={() => {
          if (description !== (task.description ?? "")) {
            commit(() => updateTask({ id: task.id, description }));
          }
        }}
        placeholder="Description"
        className="min-w-40 flex-1 bg-transparent outline-none placeholder:text-muted max-sm:min-w-0 max-sm:basis-full"
      />

      {task.status === "scheduled" && (
        <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
          scheduled
        </span>
      )}

      <input
        type="number"
        min={5}
        step={5}
        value={task.estimated_minutes}
        onChange={(e) =>
          commit(() =>
            updateTask({ id: task.id, estimatedMinutes: Number(e.target.value) }),
          )
        }
        title={fmtDuration(task.estimated_minutes)}
        className="w-16 rounded border border-line bg-surface px-1 py-0.5 text-xs tabular-nums outline-none focus:border-accent"
      />

      <select
        value={task.priority}
        onChange={(e) =>
          commit(() => updateTask({ id: task.id, priority: Number(e.target.value) }))
        }
        className="rounded border border-line bg-surface px-1 py-0.5 text-xs outline-none focus:border-accent"
      >
        {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>

      <input
        type="date"
        value={task.deadline ? task.deadline.slice(0, 10) : ""}
        onChange={(e) =>
          commit(() =>
            updateTask({
              id: task.id,
              deadline: e.target.value ? new Date(e.target.value).toISOString() : null,
            }),
          )
        }
        className="rounded border border-line bg-surface px-1 py-0.5 text-xs outline-none focus:border-accent"
      />

      <button
        onClick={() => commit(() => updateTask({ id: task.id, status: "done" }))}
        className="rounded border border-line px-1.5 py-0.5 text-xs text-muted hover:border-accent hover:text-foreground"
        title="Mark done"
      >
        ✓
      </button>
      <button
        onClick={() => commit(() => deleteTask(task.id))}
        className="rounded border border-line px-1.5 py-0.5 text-xs text-muted hover:border-red-500 hover:text-red-500"
      >
        ×
      </button>
    </li>
  );
}

function NewTaskForm({ categories }: { categories: Category[] }) {
  const [description, setDescription] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [priority, setPriority] = useState(3);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="flex flex-wrap gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        // The category is the label, so it is the one field that cannot be skipped.
        if (!categoryId) {
          setError("Pick a category");
          return;
        }
        const payload = {
          categoryId,
          description: description.trim() || null,
          estimatedMinutes: minutes,
          priority,
          deadline: null,
        };
        setDescription("");
        setError(null);
        startTransition(async () => {
          await createTask(payload);
        });
      }}
    >
      <div className="w-44 shrink-0 max-sm:w-full">
        <CategoryPicker
          categories={categories}
          value={categoryId}
          onChange={(id) => {
            setCategoryId(id);
            setError(null);
          }}
        />
      </div>
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        className="min-w-40 flex-1 rounded border border-line bg-surface px-2 py-1 text-sm outline-none focus:border-accent max-sm:min-w-0 max-sm:basis-full"
      />
      <input
        type="number"
        min={5}
        step={5}
        value={minutes}
        onChange={(e) => setMinutes(Number(e.target.value))}
        className="w-16 rounded border border-line bg-surface px-1 py-1 text-xs tabular-nums outline-none focus:border-accent"
      />
      <select
        value={priority}
        onChange={(e) => setPriority(Number(e.target.value))}
        className="rounded border border-line bg-surface px-1 py-1 text-xs outline-none focus:border-accent"
      >
        {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50"
      >
        Add
      </button>
      {error && <p className="w-full text-xs text-red-500">{error}</p>}
    </form>
  );
}
