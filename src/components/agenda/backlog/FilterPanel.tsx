"use client";

import { useMemo, useState } from "react";
import type { CategoryNode } from "@/lib/categories";
import {
  DEADLINE_FILTER_LABELS,
  type DeadlineFilter,
} from "@/lib/agenda/ranking";
import { Chip } from "./TaskEditor";
import { PRIORITY_STYLE } from "./shared";

export type Filters = {
  categoryId: string | null;
  priorities: number[];
  deadline: DeadlineFilter;
};

export const NO_FILTERS: Filters = { categoryId: null, priorities: [], deadline: "all" };

export function activeFilterCount(f: Filters): number {
  return (f.categoryId ? 1 : 0) + (f.priorities.length ? 1 : 0) + (f.deadline !== "all" ? 1 : 0);
}

/**
 * The left column on a wide screen, the Filters sheet on a phone. Categories
 * first, because "show me the poker stuff" is the filter used most; the tree
 * folds so a deep one stays short, and each row counts what is still to plan.
 */
export function FilterPanel({
  tree,
  counts,
  filters,
  onChange,
  onManageCategories,
}: {
  tree: CategoryNode[];
  /** Tasks to plan per category, subtree included. */
  counts: Map<string, number>;
  filters: Filters;
  onChange: (next: Filters) => void;
  onManageCategories: () => void;
}) {
  const total = useMemo(
    () => tree.reduce((sum, n) => sum + (counts.get(n.id) ?? 0), 0),
    [tree, counts],
  );

  return (
    <div className="space-y-6 text-sm">
      <section>
        <Heading>Category</Heading>
        <ul className="space-y-px">
          <li className="flex items-center">
            <CategoryButton
              label="All categories"
              color={null}
              count={total}
              depth={0}
              active={filters.categoryId === null}
              onClick={() => onChange({ ...filters, categoryId: null })}
            />
            <span className="w-8 shrink-0" aria-hidden />
          </li>
          {tree.map((node) => (
            <CategoryBranch
              key={node.id}
              node={node}
              counts={counts}
              selected={filters.categoryId}
              onSelect={(id) =>
                onChange({ ...filters, categoryId: filters.categoryId === id ? null : id })
              }
            />
          ))}
        </ul>
        <button
          type="button"
          onClick={onManageCategories}
          className="mt-2 px-2 text-xs text-muted hover:text-foreground"
        >
          Manage categories…
        </button>
      </section>

      <section>
        <Heading>Priority</Heading>
        <div className="flex flex-wrap gap-1.5">
          {[1, 2, 3, 4].map((p) => {
            const active = filters.priorities.includes(p);
            return (
              <Chip
                key={p}
                active={active}
                onClick={() =>
                  onChange({
                    ...filters,
                    priorities: active
                      ? filters.priorities.filter((x) => x !== p)
                      : [...filters.priorities, p].sort(),
                  })
                }
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className={`h-2 w-2 rounded-full border-2 ${PRIORITY_STYLE[p].ring}`}
                    aria-hidden
                  />
                  {PRIORITY_STYLE[p].label}
                </span>
              </Chip>
            );
          })}
        </div>
      </section>

      <section>
        <Heading>Deadline</Heading>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(DEADLINE_FILTER_LABELS) as DeadlineFilter[]).map((key) => (
            <Chip
              key={key}
              active={filters.deadline === key}
              onClick={() => onChange({ ...filters, deadline: key })}
            >
              {DEADLINE_FILTER_LABELS[key]}
            </Chip>
          ))}
        </div>
      </section>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wide text-muted">
      {children}
    </h3>
  );
}

function CategoryBranch({
  node,
  counts,
  selected,
  onSelect,
}: {
  node: CategoryNode;
  counts: Map<string, number>;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  // Open on the way to the selected category, so a filter set elsewhere (a
  // root chip, the editor) is visible here too.
  const containsSelected = useMemo(() => {
    if (!selected) return false;
    const stack = [...node.children];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.id === selected) return true;
      stack.push(...n.children);
    }
    return false;
  }, [node, selected]);
  const [open, setOpen] = useState(false);
  const expanded = open || containsSelected;
  const hasChildren = node.children.length > 0;

  return (
    <li>
      <div className="flex items-center">
        <CategoryButton
          label={node.name}
          color={node.effectiveColor}
          count={counts.get(node.id) ?? 0}
          depth={node.depth}
          active={selected === node.id}
          onClick={() => onSelect(node.id)}
          title={node.path}
        />
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen(!expanded)}
            disabled={containsSelected}
            aria-label={expanded ? `Fold ${node.name}` : `Unfold ${node.name}`}
            aria-expanded={expanded}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-[10px] text-muted hover:bg-surface hover:text-foreground disabled:opacity-40"
          >
            <span className={`transition-transform ${expanded ? "rotate-90" : ""}`}>▸</span>
          </button>
        ) : (
          <span className="w-8 shrink-0" aria-hidden />
        )}
      </div>
      {hasChildren && expanded && (
        <ul className="space-y-px">
          {node.children.map((child) => (
            <CategoryBranch
              key={child.id}
              node={child}
              counts={counts}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function CategoryButton({
  label,
  color,
  count,
  depth,
  active,
  onClick,
  title,
}: {
  label: string;
  color: string | null;
  count: number;
  depth: number;
  active: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      style={{ paddingLeft: 8 + depth * 14 }}
      className={`flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md pr-2 text-left ${
        active ? "bg-accent/10 font-medium text-accent" : "hover:bg-surface"
      }`}
    >
      {color ? (
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      ) : (
        <span className="h-2 w-2 shrink-0 rounded-full border border-muted" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count > 0 && <span className="shrink-0 text-xs tabular-nums text-muted">{count}</span>}
    </button>
  );
}
