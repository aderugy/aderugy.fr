"use client";

import { useMemo, useState, useTransition } from "react";
import { CategoryPicker } from "./CategoryPicker";
import { categoryIndex, DEFAULT_COLOR } from "@/lib/categories";
import { blockChildren, blockMinutes, childMinutes } from "@/lib/blocks";
import { fmtDuration, fmtTime, minutesOfDay } from "@/lib/time";
import type { Category, ScheduledBlock } from "@/lib/types";
import {
  addTaskToBlock,
  deleteScheduled,
  detachTask,
  updateBlockTask,
  updateScheduled,
} from "@/server/actions/schedule";

type Props = {
  block: ScheduledBlock;
  categories: Category[];
  onClose: () => void;
};

export function BlockDetail({ block, categories, onClose }: Props) {
  const [description, setDescription] = useState(block.description ?? "");
  const [pending, startTransition] = useTransition();

  const start = new Date(block.starts_at);
  const end = new Date(block.ends_at);
  const minutes = blockMinutes(block);

  const index = useMemo(() => categoryIndex(categories), [categories]);
  const children = useMemo(() => blockChildren(block, index), [block, index]);
  const claimed = childMinutes(block);
  const remaining = minutes - claimed;

  const commit = (fn: () => Promise<unknown>) => startTransition(() => void fn());

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium">Block</span>
        <button onClick={onClose} className="text-muted hover:text-foreground">
          Close
        </button>
      </div>

      <div className="tabular-nums text-muted">
        {start.toLocaleDateString(undefined, {
          weekday: "long",
          day: "numeric",
          month: "short",
        })}
        {" · "}
        {fmtTime(minutesOfDay(start))}–{fmtTime(minutesOfDay(end))} (
        {fmtDuration(minutes)})
      </div>

      <label className="block">
        <span className="text-muted">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => {
            if (description !== (block.description ?? "")) {
              commit(() => updateScheduled({ id: block.id, description }));
            }
          }}
          rows={2}
          placeholder="What this session is for"
          className="mt-1 w-full resize-none rounded border border-line bg-surface px-2 py-1 outline-none focus:border-accent"
        />
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

      {/*
        The block has no category of its own — this list is what decides where
        its hours land in the week's distribution, so the totals are stated
        rather than left to be worked out from the rows.
      */}
      <div>
        <div className="flex items-baseline gap-2">
          <span className="flex-1 text-muted">Tasks in this block</span>
          <span className="tabular-nums text-muted">
            {fmtDuration(claimed)} / {fmtDuration(minutes)}
          </span>
        </div>

        {children.length === 0 ? (
          <p className="mt-1 text-muted">
            Nothing in it yet — this time is planned but counts towards no
            category.
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {children.map((child) => (
              <li
                key={child.id}
                className="flex items-center gap-2 rounded border border-line bg-surface px-2 py-1"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: child.color ?? DEFAULT_COLOR }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{child.label}</span>
                  {child.description && (
                    <span className="block truncate text-[10px] text-muted">
                      {child.description}
                    </span>
                  )}
                </span>
                <MinutesField
                  value={child.minutes}
                  onCommit={(value) =>
                    commit(() =>
                      updateBlockTask({
                        scheduledBlockId: block.id,
                        taskId: child.id,
                        plannedMinutes: value,
                      }),
                    )
                  }
                />
                <button
                  onClick={() =>
                    commit(() =>
                      detachTask({ scheduledBlockId: block.id, taskId: child.id }),
                    )
                  }
                  className="text-muted hover:text-red-500"
                  title="Take it out of this block"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {remaining !== 0 && children.length > 0 && (
          <p
            className={`mt-1 ${remaining < 0 ? "text-red-500" : "text-muted"}`}
          >
            {remaining > 0
              ? `${fmtDuration(remaining)} unattributed`
              : `${fmtDuration(-remaining)} more than the block holds`}
          </p>
        )}

        <AddTask
          blockId={block.id}
          categories={categories}
          defaultMinutes={remaining > 0 ? remaining : 30}
        />
      </div>

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

/** Minutes as a number input that only writes once you are done typing. */
function MinutesField({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (minutes: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);

  // While not being edited the field follows the server; a re-render mid-edit
  // must not yank the caret back to a stale value.
  const shown = editing ? text : String(value);

  return (
    <input
      value={shown}
      inputMode="numeric"
      onFocus={() => {
        setText(String(value));
        setEditing(true);
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const next = Math.round(Number(text));
        if (Number.isFinite(next) && next > 0 && next !== value) onCommit(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      title="Minutes counted against this task's category"
      className="w-10 shrink-0 rounded border border-line bg-surface px-1 py-0.5 text-right tabular-nums outline-none focus:border-accent"
    />
  );
}

/**
 * Add a task straight into the block.
 *
 * Without this the only way to give a block a second category would be a round
 * trip through the backlog, which is exactly the friction the block model is
 * meant to remove.
 */
function AddTask({
  blockId,
  categories,
  defaultMinutes,
}: {
  blockId: string;
  categories: Category[];
  defaultMinutes: number;
}) {
  const [open, setOpen] = useState(false);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [minutes, setMinutes] = useState(String(defaultMinutes));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        onClick={() => {
          setMinutes(String(defaultMinutes));
          setOpen(true);
        }}
        className="mt-1 w-full rounded border border-dashed border-line px-2 py-1 text-muted hover:border-accent hover:text-foreground"
      >
        + Add a task
      </button>
    );
  }

  return (
    <form
      className="mt-1 space-y-1 rounded border border-line p-2"
      onSubmit={(e) => {
        e.preventDefault();
        const value = Math.round(Number(minutes));
        if (!categoryId) return setError("Pick a category");
        if (!Number.isFinite(value) || value <= 0) return setError("Give it a duration");

        setError(null);
        startTransition(async () => {
          const result = await addTaskToBlock({
            scheduledBlockId: blockId,
            categoryId,
            description: description.trim() || null,
            minutes: value,
          });
          if (result.ok) {
            setDescription("");
            setOpen(false);
          } else {
            setError(result.error);
          }
        });
      }}
    >
      <CategoryPicker
        categories={categories}
        value={categoryId}
        onChange={(id) => {
          setCategoryId(id);
          setError(null);
        }}
        autoFocus
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What it covers (optional)"
        className="w-full rounded border border-line bg-surface px-2 py-1 outline-none focus:border-accent"
      />
      <div className="flex gap-1">
        <input
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          inputMode="numeric"
          placeholder="min"
          className="w-14 rounded border border-line bg-surface px-1 py-1 text-right tabular-nums outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="flex-1 rounded border border-line px-2 py-1 text-muted hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-accent px-3 py-1 font-medium text-white disabled:opacity-60"
        >
          Add
        </button>
      </div>
      {error && <p className="text-red-500">{error}</p>}
    </form>
  );
}
