"use client";

import { useMemo, useState, useTransition } from "react";
import type { ReactNode } from "react";
import { buildTree, flattenTree, subtreeIds } from "@/lib/categories";
import type { CategoryNode } from "@/lib/categories";
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
  /** Minutes per category already committed by a connected calendar. */
  externalMinutes: Map<string, number>;
};

export function WeekIntent({
  weekStart,
  week,
  categories,
  objectives,
  scheduled,
  externalMinutes,
}: Props) {
  const [theme, setTheme] = useState(week.theme ?? "");
  const [guidelines, setGuidelines] = useState(week.guidelines ?? "");
  const [, startTransition] = useTransition();

  const tree = useMemo(() => buildTree(categories), [categories]);
  const flat = useMemo(() => flattenTree(tree), [tree]);

  /**
   * Minutes scheduled this week per category: `direct` is what was booked on
   * the category itself, `rolled` adds everything below it in the tree.
   */
  const { direct: directMinutes, rolled: minutesByCategory } = useMemo(() => {
    const direct = new Map<string, number>();
    for (const b of scheduled) {
      const minutes = Math.round(
        (new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 60_000,
      );
      direct.set(b.category_id, (direct.get(b.category_id) ?? 0) + minutes);
    }
    // Hours a calendar already committed count the same as hours you planned:
    // the objective asks where your time goes, not how much of it you typed in.
    for (const [categoryId, minutes] of externalMinutes) {
      direct.set(categoryId, (direct.get(categoryId) ?? 0) + minutes);
    }
    const rolled = new Map<string, number>();
    for (const c of flat) {
      const ids = subtreeIds(categories, c.id);
      let sum = 0;
      for (const id of ids) sum += direct.get(id) ?? 0;
      rolled.set(c.id, sum);
    }
    return { direct, rolled };
  }, [scheduled, externalMinutes, categories, flat]);

  const totalMinutes = useMemo(
    () =>
      tree.reduce((sum, root) => sum + (minutesByCategory.get(root.id) ?? 0), 0),
    [tree, minutesByCategory],
  );

  /**
   * One row per category with time on it, nested. A row's share is measured
   * against its parent — against the week's total for a root — so a subtree
   * reads as "how this category splits" rather than as another flat list.
   * Categories with no minutes are dropped, at every depth.
   */
  const renderShare = (
    nodes: CategoryNode[],
    parentMinutes: number,
    depth: number,
  ): ReactNode[] =>
    nodes
      .map((node) => ({ node, minutes: minutesByCategory.get(node.id) ?? 0 }))
      .filter(({ minutes }) => minutes > 0)
      .sort((a, b) => b.minutes - a.minutes)
      .map(({ node, minutes }) => {
        const share = parentMinutes > 0 ? (minutes / parentMinutes) * 100 : 0;
        const own = directMinutes.get(node.id) ?? 0;
        const children = renderShare(node.children, minutes, depth + 1);
        // Time booked on the category itself only needs a row once children
        // are also shown — otherwise it is the whole of the row above.
        const showOwn = own > 0 && children.length > 0;

        return (
          <li key={node.id}>
            <div
              className="flex items-center gap-2"
              style={{ paddingLeft: depth * 12 }}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: node.effectiveColor }}
              />
              <span className="flex-1 truncate">{node.name}</span>
              <span className="w-8 shrink-0 text-right tabular-nums text-[10px] text-muted">
                {Math.round(share)}%
              </span>
              <span className="w-12 shrink-0 text-right tabular-nums text-muted">
                {fmtDuration(minutes)}
              </span>
            </div>
            {(children.length > 0 || showOwn) && (
              <ul className="mt-0.5 space-y-0.5">
                {children}
                {showOwn && (
                  <li
                    className="flex items-center gap-2 text-muted"
                    style={{ paddingLeft: (depth + 1) * 12 }}
                  >
                    <span className="h-2 w-2 shrink-0" />
                    <span className="flex-1 truncate italic">direct</span>
                    <span className="w-8 shrink-0 text-right tabular-nums text-[10px]">
                      {Math.round((own / minutes) * 100)}%
                    </span>
                    <span className="w-12 shrink-0 text-right tabular-nums">
                      {fmtDuration(own)}
                    </span>
                  </li>
                )}
              </ul>
            )}
          </li>
        );
      });

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
        <div className="flex items-baseline gap-2">
          <span className="flex-1 text-muted">Time by category</span>
          {totalMinutes > 0 && (
            <span className="tabular-nums text-muted">{fmtDuration(totalMinutes)}</span>
          )}
        </div>
        <ul className="mt-1 space-y-0.5">{renderShare(tree, totalMinutes, 0)}</ul>
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
