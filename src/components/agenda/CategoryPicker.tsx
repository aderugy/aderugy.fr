"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildTree, flattenTree, type CategoryNode } from "@/lib/categories";
import type { Category } from "@/lib/types";
import { eventHitsElement } from "@/lib/dom";

/**
 * Searchable category select.
 *
 * Now that the category *is* the label, this is the one field always filled on
 * every creation path — so it is keyboard-first: type to filter, arrows to move,
 * Enter to pick. The full path is matched, not just the leaf, so "poker gr"
 * finds `poker > grind`.
 *
 * With no query the list is a tree: only roots show, and hovering a parent
 * expands its children (hovering another branch collapses the previous one, so
 * the list stays short). Arrow keys walk the visible rows; →/← expand and
 * collapse. Typing switches back to the flat, path-matched result list.
 */
export function CategoryPicker({
  categories,
  value,
  onChange,
  autoFocus = false,
  placeholder = "Search categories…",
}: {
  categories: Category[];
  value: string | null;
  onChange: (id: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const tree = useMemo(() => buildTree(categories), [categories]);
  const flat = useMemo(() => flattenTree(tree), [tree]);
  const selected = flat.find((c) => c.id === value) ?? null;

  /** id -> ids of its ancestors, outermost first. */
  const ancestors = useMemo(() => {
    const map = new Map<string, string[]>();
    const walk = (nodes: CategoryNode[], chain: string[]) => {
      for (const n of nodes) {
        map.set(n.id, chain);
        walk(n.children, [...chain, n.id]);
      }
    };
    walk(tree, []);
    return map;
  }, [tree]);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  const searching = query.trim().length > 0;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return flat;
    const terms = q.split(/\s+/);
    return flat.filter((c) => {
      const haystack = c.path.toLowerCase();
      return terms.every((t) => haystack.includes(t));
    });
  }, [flat, query]);

  // Searching flattens; otherwise only roots plus the expanded branches show.
  const visible = useMemo(() => {
    if (searching) return matches;
    const out: CategoryNode[] = [];
    const walk = (nodes: CategoryNode[]) => {
      for (const n of nodes) {
        out.push(n);
        if (expanded.has(n.id)) walk(n.children);
      }
    };
    walk(tree);
    return out;
  }, [searching, matches, tree, expanded]);

  const activeNode = visible.find((n) => n.id === activeId) ?? visible[0] ?? null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!eventHitsElement(e, rootRef.current)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Opening reveals the branch the current value lives in.
  useEffect(() => {
    if (!open) return;
    setActiveId(value);
    setExpanded(new Set(value ? (ancestors.get(value) ?? []) : []));
  }, [open, value, ancestors]);

  /** Hovering a row opens its branch and closes every other one. */
  function revealBranch(node: CategoryNode) {
    setActiveId(node.id);
    if (searching) return;
    const chain = ancestors.get(node.id) ?? [];
    setExpanded(new Set(node.children.length ? [...chain, node.id] : chain));
  }

  function move(delta: number) {
    if (!visible.length) return;
    const i = activeNode ? visible.indexOf(activeNode) : -1;
    const next = Math.min(Math.max(i + delta, 0), visible.length - 1);
    setActiveId(visible[next].id);
  }

  function pick(node: CategoryNode) {
    onChange(node.id);
    setQuery("");
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <input
        autoFocus={autoFocus}
        value={open ? query : (selected?.path ?? "")}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveId(null);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "ArrowRight") {
            if (!searching && activeNode?.children.length && !expanded.has(activeNode.id)) {
              e.preventDefault();
              setExpanded((prev) => new Set([...prev, activeNode.id]));
            }
          } else if (e.key === "ArrowLeft") {
            if (searching || !activeNode) return;
            if (expanded.has(activeNode.id)) {
              e.preventDefault();
              setExpanded((prev) => {
                const next = new Set(prev);
                next.delete(activeNode.id);
                return next;
              });
            } else {
              const chain = ancestors.get(activeNode.id) ?? [];
              const parent = chain[chain.length - 1];
              if (parent) {
                e.preventDefault();
                setActiveId(parent);
                setExpanded(new Set(chain.slice(0, -1)));
              }
            }
          } else if (e.key === "Enter") {
            if (open && activeNode) {
              e.preventDefault();
              pick(activeNode);
            }
          } else if (e.key === "Escape") {
            if (open) {
              e.stopPropagation();
              setOpen(false);
            }
          }
        }}
        placeholder={selected ? selected.path : placeholder}
        className="w-full rounded border border-line bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
      />

      {selected && !open && (
        <span
          className="pointer-events-none absolute left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full"
          style={{ backgroundColor: selected.effectiveColor, left: -10 }}
        />
      )}

      {open && (
        <ul className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded border border-line bg-surface py-1 shadow-lg">
          {visible.length === 0 && (
            <li className="px-2 py-1.5 text-xs text-muted">
              No category matches. Create it on the Backlog page.
            </li>
          )}
          {visible.map((node) => {
            const hasChildren = !searching && node.children.length > 0;
            return (
              <li key={node.id}>
                <button
                  type="button"
                  // pointerdown, not click: the outside-click listener fires on
                  // pointerdown and would close the list before click lands.
                  onPointerDown={(e) => {
                    e.preventDefault();
                    pick(node);
                  }}
                  onMouseEnter={() => revealBranch(node)}
                  onFocus={() => revealBranch(node)}
                  style={{ paddingLeft: searching ? 8 : 8 + node.depth * 12 }}
                  className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs ${
                    node.id === activeNode?.id ? "bg-accent/10" : ""
                  }`}
                >
                  <span
                    aria-hidden
                    className={`w-2 shrink-0 text-[9px] leading-none text-muted transition-transform ${
                      hasChildren && expanded.has(node.id) ? "rotate-90" : ""
                    }`}
                  >
                    {hasChildren ? "▸" : ""}
                  </span>
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: node.effectiveColor }}
                  />
                  <span className="truncate">{searching ? node.path : node.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
