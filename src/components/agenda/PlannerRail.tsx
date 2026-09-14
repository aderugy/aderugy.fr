"use client";

import { useMemo, useState } from "react";
import { buildTree, flattenTree, subtreeIds, DEFAULT_COLOR } from "@/lib/categories";
import { fmtDuration } from "@/lib/time";
import { PRIORITY_LABELS, type Block, type Category, type DragPayload, type Task } from "@/lib/types";

const PRIORITY_COLOR: Record<number, string> = {
  1: "#e03131",
  2: "#e8590c",
  3: "#64748b",
  4: "#9ca3af",
};

type Props = {
  categories: Category[];
  tasks: Task[];
  blocks: Block[];
  onDragStart: (payload: DragPayload) => void;
  onDragEnd: () => void;
};

export function PlannerRail({
  categories,
  tasks,
  blocks,
  onDragStart,
  onDragEnd,
}: Props) {
  const [tab, setTab] = useState<"tasks" | "blocks">("tasks");
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");

  const flatCategories = useMemo(
    () => flattenTree(buildTree(categories)),
    [categories],
  );
  const categoryById = useMemo(
    () => new Map(flatCategories.map((c) => [c.id, c])),
    [flatCategories],
  );

  const visibleTasks = useMemo(() => {
    const allowed = filter === "all" ? null : subtreeIds(categories, filter);
    const q = query.trim().toLowerCase();

    return tasks
      .filter((t) => t.status === "backlog")
      .filter((t) => !allowed || (t.category_id && allowed.has(t.category_id)))
      .filter((t) => !q || (t.description ?? "").toLowerCase().includes(q))
      .sort((a, b) => {
        // Deadlines inside the planning horizon outrank raw priority.
        const da = a.deadline ? Date.parse(a.deadline) : Infinity;
        const db = b.deadline ? Date.parse(b.deadline) : Infinity;
        if (da !== db) return da - db;
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.created_at.localeCompare(b.created_at);
      });
  }, [tasks, categories, filter, query]);

  const unscheduledMinutes = visibleTasks.reduce(
    (sum, t) => sum + t.estimated_minutes,
    0,
  );

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-line">
      <div className="flex gap-1 border-b border-line p-2 text-xs">
        {(["tasks", "blocks"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-2 py-1 capitalize ${
              tab === t ? "bg-accent text-white" : "text-muted hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
        <span className="ml-auto self-center tabular-nums text-muted">
          {tab === "tasks"
            ? `${visibleTasks.length} · ${fmtDuration(unscheduledMinutes)}`
            : `${blocks.length}`}
        </span>
      </div>

      {tab === "tasks" ? (
        <>
          <div className="space-y-2 border-b border-line p-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tasks"
              className="w-full rounded border border-line bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
            />
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full rounded border border-line bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
            >
              <option value="all">All categories</option>
              {flatCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {"— ".repeat(c.depth)}
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <ul className="flex-1 overflow-y-auto p-2">
            {visibleTasks.length === 0 && (
              <li className="px-1 py-6 text-center text-xs text-muted">
                Nothing waiting. Add tasks on the Backlog page, or draw straight on the grid.
              </li>
            )}
            {visibleTasks.map((task) => {
              const category = task.category_id
                ? categoryById.get(task.category_id)
                : undefined;
              return (
                <li
                  key={task.id}
                  draggable
                  onDragStart={(e) => {
                    const label = category?.name ?? "Uncategorised";
                    e.dataTransfer.effectAllowed = "copy";
                    e.dataTransfer.setData("text/plain", label);
                    onDragStart({
                      kind: "task",
                      id: task.id,
                      label,
                      minutes: task.estimated_minutes,
                      categoryId: task.category_id,
                      description: task.description,
                    });
                  }}
                  onDragEnd={onDragEnd}
                  className="mb-1 cursor-grab rounded border border-line bg-surface px-2 py-1.5 text-xs active:cursor-grabbing"
                  style={{
                    borderLeft: `3px solid ${category?.effectiveColor ?? DEFAULT_COLOR}`,
                  }}
                  title={`${PRIORITY_LABELS[task.priority]} · ${category?.path ?? "Uncategorised"}${
                    task.description ? ` — ${task.description}` : ""
                  }`}
                >
                  <div className="flex items-start gap-1.5">
                    <span
                      className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: PRIORITY_COLOR[task.priority] }}
                    />
                    <span className="flex-1 leading-snug font-medium">
                      {category?.name ?? "Uncategorised"}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted">
                      {fmtDuration(task.estimated_minutes)}
                    </span>
                  </div>
                  {(task.description || task.deadline) && (
                    <div className="mt-0.5 flex gap-2 pl-3 text-[10px] text-muted">
                      {task.description && (
                        <span className="truncate">{task.description}</span>
                      )}
                      {task.deadline && (
                        <span className="ml-auto shrink-0">
                          due{" "}
                          {new Date(task.deadline).toLocaleDateString(undefined, {
                            day: "numeric",
                            month: "short",
                          })}
                        </span>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <ul className="flex-1 overflow-y-auto p-2">
          {blocks.length === 0 && (
            <li className="px-1 py-6 text-center text-xs text-muted">
              No reusable blocks yet. Create them on the Blocks page.
            </li>
          )}
          {blocks.map((block) => {
            const itemMinutes = block.block_items.reduce(
              (sum, i) => sum + i.estimated_minutes,
              0,
            );
            const minutes = itemMinutes > 0 ? itemMinutes : block.default_minutes;
            const category = block.default_category_id
              ? categoryById.get(block.default_category_id)
              : undefined;
            const color = block.color ?? category?.effectiveColor ?? DEFAULT_COLOR;

            return (
              <li
                key={block.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "copy";
                  e.dataTransfer.setData("text/plain", block.name);
                  onDragStart({
                    kind: "block",
                    id: block.id,
                    label: block.name,
                    minutes,
                    categoryId: block.default_category_id,
                  });
                }}
                onDragEnd={onDragEnd}
                className="mb-1 cursor-grab rounded border border-line bg-surface px-2 py-1.5 text-xs active:cursor-grabbing"
                style={{ borderLeft: `3px solid ${color}` }}
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 leading-snug">{block.name}</span>
                  <span className="shrink-0 tabular-nums text-muted">
                    {fmtDuration(minutes)}
                  </span>
                </div>
                {block.block_items.length > 0 && (
                  <div className="mt-0.5 text-[10px] text-muted">
                    {block.block_items.length} steps
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
