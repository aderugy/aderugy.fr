"use client";

import { useMemo, useState, useTransition } from "react";
import { buildTree, flattenTree, subtreeIds } from "@/lib/categories";
import { fmtDuration } from "@/lib/time";
import type { Category, Objective, ScheduledBlock, Week } from "@/lib/types";
import {
  createObjective,
  deleteObjective,
  updateObjective,
  updateWeekMeta,
} from "@/server/actions/schedule";

type Props = {
  weekStart: string;
  week: Week;
  categories: Category[];
  objectives: Objective[];
  scheduled: ScheduledBlock[];
};

export function WeekIntent({
  weekStart,
  week,
  categories,
  objectives,
  scheduled,
}: Props) {
  const [theme, setTheme] = useState(week.theme ?? "");
  const [guidelines, setGuidelines] = useState(week.guidelines ?? "");
  const [, startTransition] = useTransition();

  const flat = useMemo(() => flattenTree(buildTree(categories)), [categories]);

  /** Minutes scheduled this week per category, rolled up into each subtree. */
  const minutesByCategory = useMemo(() => {
    const direct = new Map<string, number>();
    for (const b of scheduled) {
      if (!b.category_id) continue;
      const minutes = Math.round(
        (new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 60_000,
      );
      direct.set(b.category_id, (direct.get(b.category_id) ?? 0) + minutes);
    }
    const rolled = new Map<string, number>();
    for (const c of flat) {
      const ids = subtreeIds(categories, c.id);
      let sum = 0;
      for (const id of ids) sum += direct.get(id) ?? 0;
      rolled.set(c.id, sum);
    }
    return rolled;
  }, [scheduled, categories, flat]);

  const commit = (fn: () => Promise<unknown>) => startTransition(() => void fn());

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-xs">
      <span className="font-medium">This week</span>

      <label className="block">
        <span className="text-muted">Theme</span>
        <input
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          onBlur={() => {
            if (theme !== (week.theme ?? "")) {
              commit(() => updateWeekMeta({ weekStart, theme }));
            }
          }}
          placeholder="e.g. Ship agenda v1"
          className="mt-1 w-full rounded border border-line bg-surface px-2 py-1 outline-none focus:border-accent"
        />
      </label>

      <label className="block">
        <span className="text-muted">Guidelines</span>
        <textarea
          value={guidelines}
          onChange={(e) => setGuidelines(e.target.value)}
          onBlur={() => {
            if (guidelines !== (week.guidelines ?? "")) {
              commit(() => updateWeekMeta({ weekStart, guidelines }));
            }
          }}
          rows={4}
          placeholder="Rules for the week — what to protect, what to refuse."
          className="mt-1 w-full resize-none rounded border border-line bg-surface px-2 py-1 outline-none focus:border-accent"
        />
      </label>

      <div>
        <span className="text-muted">Objectives</span>
        <ul className="mt-1 space-y-1">
          {objectives.map((o) => {
            const scheduledMinutes = o.category_id
              ? (minutesByCategory.get(o.category_id) ?? 0)
              : 0;
            const pct = o.target_minutes
              ? Math.min(100, Math.round((scheduledMinutes / o.target_minutes) * 100))
              : null;

            return (
              <li key={o.id} className="rounded border border-line bg-surface px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={o.done}
                    onChange={(e) =>
                      commit(() => updateObjective({ id: o.id, done: e.target.checked }))
                    }
                    className="accent-[var(--accent)]"
                  />
                  <span className={`flex-1 ${o.done ? "text-muted line-through" : ""}`}>
                    {o.title}
                  </span>
                  <button
                    onClick={() => commit(() => deleteObjective(o.id))}
                    className="text-muted hover:text-red-500"
                  >
                    ×
                  </button>
                </div>
                {pct !== null && (
                  <div className="mt-1.5 pl-6">
                    <div className="h-1 overflow-hidden rounded bg-line">
                      <div
                        className="h-full rounded bg-accent"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="mt-0.5 tabular-nums text-[10px] text-muted">
                      {fmtDuration(scheduledMinutes)} planned of{" "}
                      {fmtDuration(o.target_minutes!)}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <NewObjective weekStart={weekStart} categories={flat} />
      </div>

      <div className="mt-2">
        <span className="text-muted">Time by category</span>
        <ul className="mt-1 space-y-0.5">
          {flat
            .filter((c) => c.depth === 0 && (minutesByCategory.get(c.id) ?? 0) > 0)
            .sort(
              (a, b) =>
                (minutesByCategory.get(b.id) ?? 0) - (minutesByCategory.get(a.id) ?? 0),
            )
            .map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: c.effectiveColor }}
                />
                <span className="flex-1 truncate">{c.name}</span>
                <span className="tabular-nums text-muted">
                  {fmtDuration(minutesByCategory.get(c.id) ?? 0)}
                </span>
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}

function NewObjective({
  weekStart,
  categories,
}: {
  weekStart: string;
  categories: { id: string; name: string; depth: number }[];
}) {
  const [title, setTitle] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [hours, setHours] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="mt-1 space-y-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        const payload = {
          weekStart,
          title,
          categoryId: categoryId || null,
          targetMinutes: hours ? Math.round(Number(hours) * 60) : null,
        };
        setTitle("");
        setHours("");
        startTransition(async () => {
          await createObjective(payload);
        });
      }}
    >
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Add an objective…"
        className="w-full rounded border border-line bg-surface px-2 py-1 outline-none focus:border-accent"
      />
      {title && (
        <div className="flex gap-1">
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="min-w-0 flex-1 rounded border border-line bg-surface px-1 py-1 outline-none focus:border-accent"
          >
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {"— ".repeat(c.depth)}
                {c.name}
              </option>
            ))}
          </select>
          <input
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            placeholder="h"
            inputMode="decimal"
            className="w-10 rounded border border-line bg-surface px-1 py-1 tabular-nums outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded bg-accent px-2 py-1 text-white disabled:opacity-50"
          >
            +
          </button>
        </div>
      )}
    </form>
  );
}
