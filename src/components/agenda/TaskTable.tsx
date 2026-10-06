"use client";

import { useMemo, useState, useTransition } from "react";
import { buildTree, flattenTree, DEFAULT_COLOR } from "@/lib/categories";
import { CategoryPicker } from "./CategoryPicker";
import { fmtDuration } from "@/lib/time";
import { PRIORITY_LABELS, type Category, type Task } from "@/lib/types";
import { TASK_LIMITS, parseDeadline } from "@/lib/agenda/backlog";
import { Markdown } from "@/components/ui/Markdown";
import type { ActionResult } from "@/server/auth";
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
  const [notesOpen, setNotesOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Every edit is saved once the field is left, never per keystroke: saving
  // mid-typing re-rendered the row from the server and threw the input away.
  const commit = (fn: () => Promise<ActionResult>) =>
    startTransition(async () => {
      const result = await fn();
      setError(result.ok ? null : result.error);
    });

  return (
    <li
      className="rounded border border-line bg-surface px-2 py-1.5"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <div className="flex flex-wrap items-center gap-2">
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
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder="Description"
          className="min-w-40 flex-1 bg-transparent outline-none placeholder:text-muted max-sm:min-w-0 max-sm:basis-full"
        />

        {task.status === "scheduled" && (
          <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
            scheduled
          </span>
        )}

        <DraftField
          type="number"
          value={String(task.estimated_minutes)}
          parse={(text) => {
            const n = Math.round(Number(text));
            return Number.isFinite(n) && n >= TASK_LIMITS.minMinutes && n <= TASK_LIMITS.maxMinutes
              ? n
              : undefined;
          }}
          onCommit={(n) => commit(() => updateTask({ id: task.id, estimatedMinutes: n }))}
          title={`${fmtDuration(task.estimated_minutes)} — ${TASK_LIMITS.minMinutes} to ${TASK_LIMITS.maxMinutes} minutes`}
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

        <DraftField
          type="date"
          value={task.deadline ? task.deadline.slice(0, 10) : ""}
          parse={(text) => {
            if (text === "") return null;
            const parsed = parseDeadline(text);
            return parsed.ok ? parsed.value : undefined;
          }}
          onCommit={(deadline) => commit(() => updateTask({ id: task.id, deadline }))}
          title="Deadline"
          className="rounded border border-line bg-surface px-1 py-0.5 text-xs outline-none focus:border-accent"
        />

        <button
          onClick={() => setNotesOpen((open) => !open)}
          className={`rounded border px-1.5 py-0.5 text-xs hover:border-accent hover:text-foreground ${
            task.notes ? "border-accent/50 text-accent" : "border-line text-muted"
          } ${notesOpen ? "bg-accent/10" : ""}`}
          title={task.notes ? "Show notes" : "Add notes"}
          aria-label="Notes"
          aria-expanded={notesOpen}
        >
          ¶
        </button>
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
          title="Delete"
        >
          ×
        </button>
      </div>

      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}

      {notesOpen && (
        <TaskNotes
          notes={task.notes}
          onSave={(notes) => commit(() => updateTask({ id: task.id, notes }))}
        />
      )}
    </li>
  );
}

/**
 * An input that keeps its own draft while focused and saves once, on blur or
 * Enter. `parse` turns the text into the value to save, or `undefined` when it
 * is not acceptable — the field then snaps back to the saved value.
 */
function DraftField<T>({
  type,
  value,
  parse,
  onCommit,
  title,
  className,
}: {
  type: "number" | "date";
  value: string;
  parse: (text: string) => T | undefined;
  onCommit: (value: T) => void;
  title?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);

  // While not being edited the field follows the server; a re-render mid-edit
  // must not yank the text back to a stale value.
  const shown = editing ? draft : value;

  return (
    <input
      type={type}
      value={shown}
      min={type === "number" ? TASK_LIMITS.minMinutes : undefined}
      max={type === "number" ? TASK_LIMITS.maxMinutes : undefined}
      step={type === "number" ? 5 : undefined}
      onFocus={() => {
        setDraft(value);
        setEditing(true);
      }}
      onChange={(e) => {
        setEditing(true);
        setDraft(e.target.value);
      }}
      onBlur={() => {
        setEditing(false);
        if (draft === value) return;
        const next = parse(draft);
        if (next !== undefined) onCommit(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      title={title}
      className={className}
    />
  );
}

/** The task's extended description: rendered Markdown, or an editor. */
function TaskNotes({
  notes,
  onSave,
}: {
  notes: string | null;
  onSave: (notes: string | null) => void;
}) {
  const [editing, setEditing] = useState(!notes);
  const [draft, setDraft] = useState(notes ?? "");

  if (!editing) {
    return (
      <div className="mt-2 border-t border-line pt-2">
        <Markdown source={notes ?? ""} />
        <button
          onClick={() => {
            setDraft(notes ?? "");
            setEditing(true);
          }}
          className="mt-2 text-xs text-muted hover:text-foreground"
        >
          Edit notes
        </button>
      </div>
    );
  }

  const save = () => {
    const next = draft.trim() ? draft : null;
    if (next !== (notes ?? null)) onSave(next);
    if (next) setEditing(false);
  };

  return (
    <div className="mt-2 border-t border-line pt-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") {
            setDraft(notes ?? "");
            if (notes) setEditing(false);
          }
        }}
        autoFocus
        rows={Math.min(14, Math.max(4, draft.split("\n").length + 1))}
        placeholder={"Markdown: context, links, checklists…\n- [ ] step one\n- [ ] step two"}
        className="w-full resize-y rounded border border-line bg-background px-2 py-1 font-mono text-xs outline-none focus:border-accent"
      />
      <div className="mt-1 flex items-center gap-2 text-xs">
        <span className="flex-1 text-muted">Markdown · Ctrl+Enter to save · Esc to cancel</span>
        {notes && (
          <button
            onClick={() => {
              setDraft(notes);
              setEditing(false);
            }}
            className="text-muted hover:text-foreground"
          >
            Cancel
          </button>
        )}
        <button
          onClick={save}
          className="rounded bg-accent px-2 py-0.5 font-medium text-white"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function NewTaskForm({ categories }: { categories: Category[] }) {
  const [description, setDescription] = useState("");
  const [minutes, setMinutes] = useState("30");
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
        const estimatedMinutes = Math.round(Number(minutes));
        if (
          !Number.isFinite(estimatedMinutes) ||
          estimatedMinutes < TASK_LIMITS.minMinutes ||
          estimatedMinutes > TASK_LIMITS.maxMinutes
        ) {
          setError(`Estimate: ${TASK_LIMITS.minMinutes} to ${TASK_LIMITS.maxMinutes} minutes`);
          return;
        }
        const payload = {
          categoryId,
          description: description.trim() || null,
          estimatedMinutes,
          priority,
          deadline: null,
        };
        const typed = description;
        setDescription("");
        setError(null);
        startTransition(async () => {
          const result = await createTask(payload);
          if (!result.ok) {
            // Give the text back rather than losing it with the failed save.
            setDescription(typed);
            setError(result.error);
          }
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
        onChange={(e) => setMinutes(e.target.value)}
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
