"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  buildTree,
  flattenTree,
  subtreeIds,
  DEFAULT_COLOR,
  type CategoryNode,
} from "@/lib/categories";
import type { Category, TaskStatus } from "@/lib/types";
import {
  DEADLINE_FILTER_LABELS,
  SORT_LABELS,
  comparator,
  deadlineLabel,
  matchesDeadline,
  type DeadlineTone,
  type SortKey,
} from "@/lib/agenda/ranking";
import { fmtDuration } from "@/lib/time";
import { deleteTask, updateTask } from "@/server/actions/tasks";
import { Sheet } from "@/components/ui/Sheet";
import { CategoryTree } from "../CategoryTree";
import { QuickAdd } from "./QuickAdd";
import { TaskEditor, Chip } from "./TaskEditor";
import {
  FilterPanel,
  NO_FILTERS,
  activeFilterCount,
  type Filters,
} from "./FilterPanel";
import { PRIORITY_STYLE, type BacklogTask } from "./shared";

type GroupBy = "none" | "category";
type SectionKey = "backlog" | "scheduled";

type ViewPrefs = {
  sort: SortKey;
  groupBy: GroupBy;
  /** Folded sections and category groups, by key. */
  folded: string[];
  /** The quick-add category when no filter picks one. */
  lastCategory: string | null;
};

const PREFS_KEY = "agenda.backlog.view.v1";
const DEFAULT_PREFS: ViewPrefs = {
  sort: "smart",
  groupBy: "none",
  folded: ["section:scheduled"],
  lastCategory: null,
};

function loadPrefs(): ViewPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<ViewPrefs>;
    return {
      sort: parsed.sort && parsed.sort in SORT_LABELS ? parsed.sort : DEFAULT_PREFS.sort,
      groupBy: parsed.groupBy === "category" ? "category" : "none",
      folded: Array.isArray(parsed.folded) ? parsed.folded : DEFAULT_PREFS.folded,
      lastCategory: typeof parsed.lastCategory === "string" ? parsed.lastCategory : null,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/**
 * The backlog: what is waiting to be planned, and — apart, never mixed in —
 * what is already on the grid. Ranked by urgency (priority, lifted by a
 * close deadline), filterable from the side column or the Filters sheet, and
 * edited by tapping a row.
 */
export function BacklogView({
  categories,
  tasks,
  today,
}: {
  categories: Category[];
  tasks: BacklogTask[];
  /** The local calendar date, from the server so both renders agree. */
  today: string;
}) {
  const tree = useMemo(() => buildTree(categories), [categories]);
  const flat = useMemo(() => flattenTree(tree), [tree]);
  const byId = useMemo(() => new Map(flat.map((c) => [c.id, c])), [flat]);
  /** category id -> its root, for grouping. */
  const rootOf = useMemo(() => {
    const map = new Map<string, CategoryNode>();
    const walk = (nodes: CategoryNode[], root: CategoryNode | null) => {
      for (const n of nodes) {
        map.set(n.id, root ?? n);
        walk(n.children, root ?? n);
      }
    };
    walk(tree, null);
    return map;
  }, [tree]);

  /* ------------------------------------------------------------ state */

  const [prefs, setPrefsState] = useState<ViewPrefs>(DEFAULT_PREFS);
  useEffect(() => {
    // After mount: the server render has no localStorage, and both must match.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrefsState(loadPrefs());
  }, []);
  const setPrefs = useCallback((update: (p: ViewPrefs) => ViewPrefs) => {
    setPrefsState((p) => {
      const next = update(p);
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // Private mode or full storage: the view just won't be remembered.
      }
      return next;
    });
  }, []);

  const [filters, setFiltersState] = useState<Filters>(NO_FILTERS);
  const [query, setQuery] = useState("");
  const [quickCategory, setQuickCategory] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  /** Rows taken out of the list while their change is on the way (done, deleted). */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const [, startTransition] = useTransition();

  const setFilters = useCallback((next: Filters) => {
    setFiltersState(next);
    // Filtering to a category is also saying where new tasks go.
    if (next.categoryId) setQuickCategory(next.categoryId);
  }, []);

  const quickAddCategory =
    [quickCategory, prefs.lastCategory].find((id) => id && byId.has(id)) ?? null;

  const isFolded = (key: string) => prefs.folded.includes(key);
  const toggleFold = (key: string) =>
    setPrefs((p) => ({
      ...p,
      folded: p.folded.includes(key) ? p.folded.filter((k) => k !== key) : [...p.folded, key],
    }));

  /* ------------------------------------------------------------ derive */

  const visibleTasks = useMemo(() => tasks.filter((t) => !hidden.has(t.id)), [tasks, hidden]);

  // Counts ignore the filters, so the tree always says where the work is.
  const counts = useMemo(() => {
    const direct = new Map<string, number>();
    for (const t of visibleTasks) {
      if (t.status !== "backlog") continue;
      direct.set(t.category_id, (direct.get(t.category_id) ?? 0) + 1);
    }
    const total = new Map<string, number>();
    const sum = (n: CategoryNode): number => {
      const s = (direct.get(n.id) ?? 0) + n.children.reduce((a, c) => a + sum(c), 0);
      total.set(n.id, s);
      return s;
    };
    tree.forEach(sum);
    return total;
  }, [visibleTasks, tree]);

  const directCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) m.set(t.category_id, (m.get(t.category_id) ?? 0) + 1);
    return m;
  }, [tasks]);

  const filtered = useMemo(() => {
    const subtree = filters.categoryId ? subtreeIds(categories, filters.categoryId) : null;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return visibleTasks.filter((t) => {
      if (subtree && !subtree.has(t.category_id)) return false;
      if (filters.priorities.length && !filters.priorities.includes(t.priority)) return false;
      if (!matchesDeadline(t.deadline, filters.deadline, today)) return false;
      if (terms.length) {
        const haystack = [t.description, t.notes, byId.get(t.category_id)?.path]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!terms.every((term) => haystack.includes(term))) return false;
      }
      return true;
    });
  }, [visibleTasks, filters, query, categories, today, byId]);

  const backlog = useMemo(
    () => filtered.filter((t) => t.status === "backlog").sort(comparator(prefs.sort, today)),
    [filtered, prefs.sort, today],
  );
  // What is on the grid reads best in the order it will happen.
  const scheduled = useMemo(
    () =>
      filtered
        .filter((t) => t.status === "scheduled")
        .sort(
          (a, b) =>
            (a.scheduled_at ? Date.parse(a.scheduled_at) : Infinity) -
              (b.scheduled_at ? Date.parse(b.scheduled_at) : Infinity) ||
            comparator("smart", today)(a, b),
        ),
    [filtered, today],
  );

  const editing = editingId ? (tasks.find((t) => t.id === editingId) ?? null) : null;
  const filterCount = activeFilterCount(filters);
  const anyFilter = filterCount > 0 || query.trim().length > 0;

  /* ----------------------------------------------------------- actions */

  const hide = (id: string, on: boolean) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const markDone = (task: BacklogTask) => {
    const previous: TaskStatus = task.status;
    hide(task.id, true);
    startTransition(async () => {
      const result = await updateTask({ id: task.id, status: "done" });
      if (!result.ok) {
        hide(task.id, false);
        setToast({ text: result.error, tone: "error" });
        return;
      }
      setToast({
        text: `Done · ${task.description || byId.get(task.category_id)?.name || "task"}`,
        undo: () => {
          startTransition(async () => {
            const back = await updateTask({ id: task.id, status: previous });
            if (back.ok) hide(task.id, false);
            else setToast({ text: back.error, tone: "error" });
          });
        },
      });
    });
  };

  const remove = (task: BacklogTask) => {
    hide(task.id, true);
    startTransition(async () => {
      const result = await deleteTask(task.id);
      if (!result.ok) {
        hide(task.id, false);
        setToast({ text: result.error, tone: "error" });
      } else {
        setToast({ text: "Task deleted" });
      }
    });
  };

  /* ------------------------------------------------------------ render */

  const filterPanel = (
    <FilterPanel
      tree={tree}
      counts={counts}
      filters={filters}
      onChange={setFilters}
      onManageCategories={() => {
        setFiltersOpen(false);
        setManaging(true);
      }}
    />
  );

  const viewOptions = (
    <ViewOptions
      sort={prefs.sort}
      groupBy={prefs.groupBy}
      onSort={(sort) => setPrefs((p) => ({ ...p, sort }))}
      onGroup={(groupBy) => setPrefs((p) => ({ ...p, groupBy }))}
    />
  );

  const renderList = (list: BacklogTask[], section: SectionKey) => {
    if (prefs.groupBy === "none") {
      return (
        <TaskList
          tasks={list}
          byId={byId}
          today={today}
          onOpen={setEditingId}
          onDone={markDone}
          onDelete={remove}
        />
      );
    }
    const groups = new Map<string, { root: CategoryNode | null; tasks: BacklogTask[] }>();
    for (const t of list) {
      const root = rootOf.get(t.category_id) ?? null;
      const key = root?.id ?? "none";
      const g = groups.get(key);
      if (g) g.tasks.push(t);
      else groups.set(key, { root, tasks: [t] });
    }
    const ordered = [...groups.entries()].sort(
      ([, a], [, b]) =>
        (a.root ? tree.indexOf(a.root) : Infinity) - (b.root ? tree.indexOf(b.root) : Infinity),
    );
    return (
      <div className="space-y-3">
        {ordered.map(([key, group]) => {
          const foldKey = `group:${section}:${key}`;
          const folded = isFolded(foldKey);
          return (
            <div key={key}>
              <button
                type="button"
                onClick={() => toggleFold(foldKey)}
                aria-expanded={!folded}
                className="flex w-full items-center gap-2 px-1 py-1.5 text-xs text-muted hover:text-foreground"
              >
                <Caret open={!folded} />
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: group.root?.effectiveColor ?? DEFAULT_COLOR }}
                />
                <span className="font-medium text-foreground">{group.root?.name ?? "Other"}</span>
                <span className="tabular-nums">{group.tasks.length}</span>
                <span className="ml-auto tabular-nums">{fmtDuration(totalMinutes(group.tasks))}</span>
              </button>
              {!folded && (
                <TaskList
                  tasks={group.tasks}
                  byId={byId}
                  today={today}
                  onOpen={setEditingId}
                  onDone={markDone}
                  onDelete={remove}
                />
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <main className="mx-auto w-full max-w-5xl px-3 pb-24 sm:px-6 lg:grid lg:grid-cols-[230px_1fr] lg:gap-10 lg:py-8">
      <aside className="hidden lg:block">
        <div className="sticky top-8 max-h-[calc(100dvh-8rem)] overflow-y-auto pr-1">
          {filterPanel}
          <div className="mt-6 border-t border-line pt-4">{viewOptions}</div>
        </div>
      </aside>

      <div className="min-w-0">
        {/* Capture and narrow stay in reach while the list scrolls under them. */}
        <div className="sticky top-0 z-20 -mx-3 space-y-2 bg-background/95 px-3 pb-2 pt-3 backdrop-blur sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:bg-transparent lg:px-0 lg:pt-0 lg:backdrop-blur-none">
          <QuickAdd
            categories={categories}
            byId={byId}
            categoryId={quickAddCategory}
            onCategoryChange={(id) => {
              setQuickCategory(id);
              setPrefs((p) => ({ ...p, lastCategory: id }));
            }}
          />

          <div className="flex items-center gap-2">
            <label className="relative min-w-0 flex-1">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted" aria-hidden>
                ⌕
              </span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search tasks"
                className="w-full rounded-md border border-line bg-surface py-1.5 pl-7 pr-2 text-base outline-none focus:border-accent sm:text-xs"
              />
            </label>
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs lg:hidden ${
                filterCount ? "border-accent bg-accent/10 text-accent" : "border-line text-muted"
              }`}
            >
              Filters
              {filterCount > 0 && (
                <span className="rounded-full bg-accent px-1.5 text-[10px] font-medium text-white">
                  {filterCount}
                </span>
              )}
            </button>
          </div>

          {/* One tap to the big buckets on a phone; the tree is in Filters. */}
          <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 [scrollbar-width:none] lg:hidden [&::-webkit-scrollbar]:hidden">
            <Chip active={!filters.categoryId} onClick={() => setFilters({ ...filters, categoryId: null })}>
              All
            </Chip>
            {filters.categoryId && byId.get(filters.categoryId)?.depth ? (
              <Chip active onClick={() => setFilters({ ...filters, categoryId: null })}>
                {byId.get(filters.categoryId)?.name} ✕
              </Chip>
            ) : null}
            {tree.map((root) => (
              <Chip
                key={root.id}
                active={filters.categoryId === root.id}
                onClick={() =>
                  setFilters({
                    ...filters,
                    categoryId: filters.categoryId === root.id ? null : root.id,
                  })
                }
              >
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: root.effectiveColor }} />
                  {root.name}
                  {(counts.get(root.id) ?? 0) > 0 && (
                    <span className="tabular-nums opacity-60">{counts.get(root.id)}</span>
                  )}
                </span>
              </Chip>
            ))}
          </div>

          {(filters.priorities.length > 0 || filters.deadline !== "all") && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs lg:hidden">
              {filters.priorities.length > 0 && (
                <Chip active onClick={() => setFilters({ ...filters, priorities: [] })}>
                  {filters.priorities.map((p) => PRIORITY_STYLE[p].label).join(", ")} ✕
                </Chip>
              )}
              {filters.deadline !== "all" && (
                <Chip active onClick={() => setFilters({ ...filters, deadline: "all" })}>
                  {DEADLINE_FILTER_LABELS[filters.deadline]} ✕
                </Chip>
              )}
            </div>
          )}
        </div>

        <div className="mt-3 space-y-6 lg:mt-6">
          <Section
            title="To plan"
            tasks={backlog}
            folded={isFolded("section:backlog")}
            onToggle={() => toggleFold("section:backlog")}
            empty={
              anyFilter ? (
                <EmptyFiltered
                  onClear={() => {
                    setFilters(NO_FILTERS);
                    setQuery("");
                  }}
                />
              ) : (
                "Nothing waiting. Add a task above."
              )
            }
          >
            {renderList(backlog, "backlog")}
          </Section>

          <Section
            title="Scheduled"
            subtitle="on the grid"
            tasks={scheduled}
            folded={isFolded("section:scheduled")}
            onToggle={() => toggleFold("section:scheduled")}
            empty={anyFilter ? "Nothing scheduled matches." : "Nothing on the grid yet."}
          >
            {renderList(scheduled, "scheduled")}
          </Section>
        </div>
      </div>

      {filtersOpen && (
        <Sheet
          title="Filters"
          onClose={() => setFiltersOpen(false)}
          footer={
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setFilters(NO_FILTERS)}
                disabled={filterCount === 0}
                className="text-xs text-muted hover:text-foreground disabled:opacity-40"
              >
                Clear all
              </button>
              <button
                type="button"
                onClick={() => setFiltersOpen(false)}
                className="ml-auto rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-white"
              >
                Show {backlog.length + scheduled.length} task
                {backlog.length + scheduled.length === 1 ? "" : "s"}
              </button>
            </div>
          }
        >
          {filterPanel}
          <div className="mt-6 border-t border-line pt-4">{viewOptions}</div>
        </Sheet>
      )}

      {managing && (
        <Sheet title="Categories" onClose={() => setManaging(false)}>
          <CategoryTree categories={categories} taskCounts={directCounts} />
        </Sheet>
      )}

      {editing && (
        <TaskEditor
          key={editing.id}
          task={editing}
          categories={categories}
          today={today}
          onClose={() => setEditingId(null)}
          onDone={markDone}
        />
      )}

      {toast && <ToastBar toast={toast} onDismiss={() => setToast(null)} />}
    </main>
  );
}

/* =============================================================== pieces */

function totalMinutes(tasks: BacklogTask[]) {
  return tasks.reduce((sum, t) => sum + t.estimated_minutes, 0);
}

function Caret({ open }: { open: boolean }) {
  return (
    <span aria-hidden className={`inline-block w-3 text-[10px] transition-transform ${open ? "rotate-90" : ""}`}>
      ▸
    </span>
  );
}

function Section({
  title,
  subtitle,
  tasks,
  folded,
  onToggle,
  empty,
  children,
}: {
  title: string;
  subtitle?: string;
  tasks: BacklogTask[];
  folded: boolean;
  onToggle: () => void;
  empty: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!folded}
        className="flex w-full items-baseline gap-2 border-b border-line pb-2 text-left"
      >
        <Caret open={!folded} />
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs tabular-nums text-muted">{tasks.length}</span>
        {subtitle && <span className="hidden text-xs text-muted sm:inline">· {subtitle}</span>}
        {tasks.length > 0 && (
          <span className="ml-auto text-xs tabular-nums text-muted">
            {fmtDuration(totalMinutes(tasks))}
          </span>
        )}
      </button>
      {!folded && (
        <div className="pt-1">
          {tasks.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted">{empty}</div>
          ) : (
            children
          )}
        </div>
      )}
    </section>
  );
}

function EmptyFiltered({ onClear }: { onClear: () => void }) {
  return (
    <span>
      No task matches.{" "}
      <button type="button" onClick={onClear} className="text-accent hover:underline">
        Clear filters
      </button>
    </span>
  );
}

function ViewOptions({
  sort,
  groupBy,
  onSort,
  onGroup,
}: {
  sort: SortKey;
  groupBy: GroupBy;
  onSort: (s: SortKey) => void;
  onGroup: (g: GroupBy) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wide text-muted">
          Sort
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
            <Chip
              key={key}
              active={sort === key}
              onClick={() => onSort(key)}
              title={key === "smart" ? "Priority, lifted by a close deadline" : undefined}
            >
              {SORT_LABELS[key]}
            </Chip>
          ))}
        </div>
      </div>
      <div>
        <h3 className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wide text-muted">
          Group
        </h3>
        <div className="flex flex-wrap gap-1.5">
          <Chip active={groupBy === "none"} onClick={() => onGroup("none")}>
            None
          </Chip>
          <Chip active={groupBy === "category"} onClick={() => onGroup("category")}>
            By category
          </Chip>
        </div>
      </div>
    </div>
  );
}

function TaskList({
  tasks,
  byId,
  today,
  onOpen,
  onDone,
  onDelete,
}: {
  tasks: BacklogTask[];
  byId: Map<string, CategoryNode>;
  today: string;
  onOpen: (id: string) => void;
  onDone: (task: BacklogTask) => void;
  onDelete: (task: BacklogTask) => void;
}) {
  return (
    <ul className="divide-y divide-line">
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          category={byId.get(task.category_id) ?? null}
          today={today}
          onOpen={() => onOpen(task.id)}
          onDone={() => onDone(task)}
          onDelete={() => onDelete(task)}
        />
      ))}
    </ul>
  );
}

const TONE_CLASS: Record<DeadlineTone, string> = {
  overdue: "text-red-500 font-medium",
  soon: "text-[#e8590c] font-medium",
  week: "text-foreground",
  later: "text-muted",
};

function TaskRow({
  task,
  category,
  today,
  onOpen,
  onDone,
  onDelete,
}: {
  task: BacklogTask;
  category: CategoryNode | null;
  today: string;
  onOpen: () => void;
  onDone: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const priority = PRIORITY_STYLE[task.priority] ?? PRIORITY_STYLE[3];
  const deadline = task.deadline ? deadlineLabel(task.deadline, today) : null;
  const name = category?.name ?? "No category";

  return (
    <li className="group flex items-start gap-1">
      <button
        type="button"
        onClick={onDone}
        title={`Mark done · ${priority.label}`}
        aria-label={`Mark done: ${task.description ?? name}`}
        className="flex h-11 w-10 shrink-0 items-center justify-center"
      >
        <span
          className={`flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 text-[10px] text-transparent transition-colors hover:text-[var(--p)] ${priority.ring}`}
          style={{ "--p": priority.color } as React.CSSProperties}
        >
          ✓
        </span>
      </button>

      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 py-2.5 text-left"
      >
        <span className={`line-clamp-2 text-sm ${task.description ? "" : "italic text-muted"}`}>
          {task.description || name}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted">
          <span className="flex min-w-0 items-center gap-1" title={category?.path}>
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: category?.effectiveColor ?? DEFAULT_COLOR }}
            />
            <span className="max-w-[10rem] truncate">{name}</span>
          </span>
          <span className="tabular-nums">{fmtDuration(task.estimated_minutes)}</span>
          {task.priority <= 2 && (
            <span style={{ color: priority.color }} className="font-medium">
              {priority.label}
            </span>
          )}
          {deadline && (
            <span className={TONE_CLASS[deadline.tone]} title={`Deadline ${task.deadline?.slice(0, 10)}`}>
              ⚑ {deadline.text}
            </span>
          )}
          {task.status === "scheduled" && task.scheduled_label && (
            <span className="text-accent">▦ {task.scheduled_label}</span>
          )}
          {task.notes && <span title="Has notes">¶</span>}
        </span>
      </button>

      <button
        type="button"
        onClick={() => {
          if (confirming) onDelete();
          else setConfirming(true);
        }}
        title={confirming ? "Tap again to delete" : "Delete"}
        aria-label={confirming ? "Confirm delete" : "Delete"}
        className={`mt-2 flex h-7 shrink-0 items-center justify-center rounded-md text-xs transition ${
          confirming
            ? "bg-red-500 px-2 font-medium text-white"
            : "w-8 text-muted/60 hover:text-red-500 lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100"
        }`}
      >
        {confirming ? "Delete?" : "✕"}
      </button>
    </li>
  );
}

type Toast = { text: string; tone?: "error"; undo?: () => void };

function ToastBar({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, toast.undo ? 6000 : 3500);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);

  return (
    <div
      role="status"
      className="fixed inset-x-3 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-sm items-center gap-3 rounded-lg bg-foreground px-4 py-2.5 text-xs text-background shadow-xl"
    >
      <span className={`min-w-0 flex-1 truncate ${toast.tone === "error" ? "text-red-300" : ""}`}>
        {toast.text}
      </span>
      {toast.undo && (
        <button
          type="button"
          onClick={() => {
            toast.undo?.();
            onDismiss();
          }}
          className="shrink-0 font-semibold underline underline-offset-2"
        >
          Undo
        </button>
      )}
    </div>
  );
}
