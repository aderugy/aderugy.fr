"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildTree, flattenTree, type CategoryNode } from "@/lib/categories";
import type { Category } from "@/lib/types";

/**
 * Searchable category select.
 *
 * Now that the category *is* the label, this is the one field always filled on
 * every creation path — so it is keyboard-first: type to filter, arrows to move,
 * Enter to pick. The full path is matched, not just the leaf, so "poker gr"
 * finds `poker > grind`.
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
  const flat = useMemo(() => flattenTree(buildTree(categories)), [categories]);
  const selected = flat.find((c) => c.id === value) ?? null;

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [activeFor, setActiveFor] = useState(query);
  const rootRef = useRef<HTMLDivElement>(null);

  // A new query means a new list, so the highlight returns to the top.
  if (activeFor !== query) {
    setActiveFor(query);
    setActive(0);
  }

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return flat;
    const terms = q.split(/\s+/);
    return flat.filter((c) => {
      const haystack = c.path.toLowerCase();
      return terms.every((t) => haystack.includes(t));
    });
  }, [flat, query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

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
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            if (open && matches[active]) {
              e.preventDefault();
              pick(matches[active]);
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
          {matches.length === 0 && (
            <li className="px-2 py-1.5 text-xs text-muted">
              No category matches. Create it on the Backlog page.
            </li>
          )}
          {matches.map((node, i) => (
            <li key={node.id}>
              <button
                type="button"
                // pointerdown, not click: the outside-click listener fires on
                // pointerdown and would close the list before click lands.
                onPointerDown={(e) => {
                  e.preventDefault();
                  pick(node);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs ${
                  i === active ? "bg-accent/10" : ""
                }`}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: node.effectiveColor }}
                />
                <span className="truncate">
                  {query ? (
                    node.path
                  ) : (
                    <>
                      <span className="text-muted">
                        {"— ".repeat(node.depth)}
                      </span>
                      {node.name}
                    </>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
