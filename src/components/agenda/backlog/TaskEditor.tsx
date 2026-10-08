"use client";

import { useMemo, useState, useTransition } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { Markdown } from "@/components/ui/Markdown";
import { CategoryPicker } from "../CategoryPicker";
import type { Category } from "@/lib/types";
import { TASK_LIMITS, parseDeadline } from "@/lib/agenda/backlog";
import { deadlineShortcuts } from "@/lib/agenda/ranking";
import { fmtDuration } from "@/lib/time";
import { updateTask, deleteTask } from "@/server/actions/tasks";
import { ESTIMATE_PRESETS, PRIORITY_STYLE, type BacklogTask } from "./shared";

/**
 * Everything about one task, in one place. The list stays a list of things to
 * pick from; editing happens here, with an explicit Save so a stray tap on a
 * phone never changes a task. Only the fields that changed are sent.
 */
export function TaskEditor({
  task,
  categories,
  today,
  onClose,
  onDone,
}: {
  task: BacklogTask;
  categories: Category[];
  today: string;
  onClose: () => void;
  /** Hands "mark done" back to the list, which owns the undo toast. */
  onDone: (task: BacklogTask) => void;
}) {
  const initial = useMemo(
    () => ({
      description: task.description ?? "",
      categoryId: task.category_id,
      minutes: String(task.estimated_minutes),
      priority: task.priority,
      deadline: task.deadline ? task.deadline.slice(0, 10) : "",
      notes: task.notes ?? "",
    }),
    [task],
  );
  const [draft, setDraft] = useState(initial);
  const [notesMode, setNotesMode] = useState<"edit" | "preview">(task.notes ? "preview" : "edit");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setError(null);
  };

  const dirty = (Object.keys(initial) as (keyof typeof initial)[]).some(
    (k) => initial[k] !== draft[k],
  );

  function save() {
    const patch: Parameters<typeof updateTask>[0] = { id: task.id };

    if (draft.description !== initial.description) {
      patch.description = draft.description.trim() || null;
    }
    if (draft.categoryId !== initial.categoryId) patch.categoryId = draft.categoryId;
    if (draft.minutes !== initial.minutes) {
      const n = Math.round(Number(draft.minutes));
      if (!Number.isFinite(n) || n < TASK_LIMITS.minMinutes || n > TASK_LIMITS.maxMinutes) {
        setError(`Estimate: ${TASK_LIMITS.minMinutes} to ${TASK_LIMITS.maxMinutes} minutes.`);
        return;
      }
      patch.estimatedMinutes = n;
    }
    if (draft.priority !== initial.priority) patch.priority = draft.priority;
    if (draft.deadline !== initial.deadline) {
      const parsed = parseDeadline(draft.deadline);
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      patch.deadline = parsed.value;
    }
    if (draft.notes !== initial.notes) patch.notes = draft.notes.trim() ? draft.notes : null;

    startTransition(async () => {
      const result = await updateTask(patch);
      if (result.ok) onClose();
      else setError(result.error);
    });
  }

  function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    startTransition(async () => {
      const result = await deleteTask(task.id);
      if (result.ok) onClose();
      else setError(result.error);
    });
  }

  const minutesNumber = Number(draft.minutes);

  return (
    <Sheet
      title={task.status === "scheduled" ? "Edit scheduled task" : "Edit task"}
      onClose={onClose}
      footer={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            className={`rounded-md px-2.5 py-1.5 text-xs ${
              confirmDelete
                ? "bg-red-500 font-medium text-white"
                : "text-muted hover:text-red-500"
            }`}
          >
            {confirmDelete ? "Tap again to delete" : "Delete"}
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onDone(task);
                onClose();
              }}
              disabled={pending}
              className="rounded-md border border-line px-3 py-1.5 text-xs hover:border-accent"
            >
              ✓ Done
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || pending}
              className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      }
    >
      <form
        className="space-y-5 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) save();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (dirty) save();
          }
        }}
      >
        {task.status === "scheduled" && task.scheduled_label && (
          <p className="rounded-md bg-accent/10 px-2.5 py-1.5 text-xs text-accent">
            On the grid · {task.scheduled_label}
          </p>
        )}

        <textarea
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
          onKeyDown={(e) => {
            // One line in spirit: Enter saves rather than breaking the line.
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              if (dirty) save();
            }
          }}
          rows={2}
          placeholder="What is it, in a few words?"
          className="w-full resize-none rounded-md border border-line bg-surface px-3 py-2 text-base outline-none focus:border-accent sm:text-sm"
        />

        <Field label="Category">
          <CategoryPicker
            categories={categories}
            value={draft.categoryId}
            onChange={(id) => set("categoryId", id)}
          />
        </Field>

        <Field label="Priority">
          <div className="grid grid-cols-4 gap-1.5">
            {[1, 2, 3, 4].map((p) => {
              const style = PRIORITY_STYLE[p];
              const active = draft.priority === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => set("priority", p)}
                  aria-pressed={active}
                  className={`flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs ${
                    active ? "border-accent bg-accent/10 font-medium" : "border-line hover:border-accent/60"
                  }`}
                >
                  <span
                    className={`h-2.5 w-2.5 rounded-full border-2 ${style.ring}`}
                    aria-hidden
                  />
                  {style.label}
                </button>
              );
            })}
          </div>
        </Field>

        <Field
          label="Estimate"
          hint={
            Number.isFinite(minutesNumber) && minutesNumber >= TASK_LIMITS.minMinutes
              ? fmtDuration(minutesNumber)
              : undefined
          }
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {ESTIMATE_PRESETS.map((m) => (
              <Chip
                key={m}
                active={draft.minutes === String(m)}
                onClick={() => set("minutes", String(m))}
              >
                {fmtDuration(m)}
              </Chip>
            ))}
            <label className="flex items-center gap-1 text-xs text-muted">
              <input
                type="number"
                inputMode="numeric"
                min={TASK_LIMITS.minMinutes}
                max={TASK_LIMITS.maxMinutes}
                step={5}
                value={draft.minutes}
                onChange={(e) => set("minutes", e.target.value)}
                className="w-16 rounded-md border border-line bg-surface px-2 py-1.5 text-base tabular-nums text-foreground outline-none focus:border-accent sm:text-xs"
              />
              min
            </label>
          </div>
        </Field>

        <Field label="Deadline">
          <div className="flex flex-wrap items-center gap-1.5">
            {deadlineShortcuts(today).map((s) => (
              <Chip
                key={s.label}
                active={draft.deadline === s.date}
                onClick={() => set("deadline", s.date)}
              >
                {s.label}
              </Chip>
            ))}
            <input
              type="date"
              value={draft.deadline}
              onChange={(e) => set("deadline", e.target.value)}
              className="rounded-md border border-line bg-surface px-2 py-1 text-base outline-none focus:border-accent sm:text-xs"
            />
            {draft.deadline && (
              <button
                type="button"
                onClick={() => set("deadline", "")}
                className="px-1 text-xs text-muted hover:text-foreground"
              >
                Clear
              </button>
            )}
          </div>
        </Field>

        <Field
          label="Notes"
          action={
            <div className="flex gap-1 text-xs">
              {(["edit", "preview"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setNotesMode(mode)}
                  className={`rounded px-1.5 py-0.5 ${
                    notesMode === mode ? "bg-surface text-foreground" : "text-muted hover:text-foreground"
                  }`}
                >
                  {mode === "edit" ? "Write" : "Preview"}
                </button>
              ))}
            </div>
          }
        >
          {notesMode === "edit" ? (
            <textarea
              value={draft.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={Math.min(14, Math.max(4, draft.notes.split("\n").length + 1))}
              placeholder={"Markdown: context, links, checklists…\n- [ ] step one"}
              className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 font-mono text-base outline-none focus:border-accent sm:text-xs"
            />
          ) : draft.notes.trim() ? (
            <button
              type="button"
              onClick={() => setNotesMode("edit")}
              className="block w-full rounded-md border border-line bg-surface px-3 py-2 text-left"
              title="Edit notes"
            >
              <Markdown source={draft.notes} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setNotesMode("edit")}
              className="text-xs text-muted hover:text-foreground"
            >
              + Add notes
            </button>
          )}
        </Field>

        {error && <p className="text-xs text-red-500">{error}</p>}
        <p className="hidden text-[11px] text-muted sm:block">
          Ctrl+Enter to save · Esc to close
        </p>
      </form>
    </Sheet>
  );
}

function Field({
  label,
  hint,
  action,
  children,
}: {
  label: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        {hint && <span className="text-xs text-muted/70">{hint}</span>}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </div>
  );
}

export function Chip({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={`shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active
          ? "border-accent bg-accent/10 text-accent"
          : "border-line text-muted hover:border-accent/60 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
