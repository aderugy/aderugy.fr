"use client";

import { useState, useTransition } from "react";
import { buildTree, PALETTE, type CategoryNode } from "@/lib/categories";
import type { Category } from "@/lib/types";
import {
  createCategory,
  deleteCategory,
  updateCategory,
} from "@/server/actions/categories";

export function CategoryTree({
  categories,
  taskCounts,
}: {
  categories: Category[];
  taskCounts: Map<string, number>;
}) {
  const tree = buildTree(categories);
  const [addingRoot, setAddingRoot] = useState(false);

  return (
    <div className="text-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">Categories</h2>
        <button
          onClick={() => setAddingRoot((v) => !v)}
          className="rounded border border-line px-2 py-0.5 text-xs hover:border-accent"
        >
          {addingRoot ? "Cancel" : "Add root"}
        </button>
      </div>

      {addingRoot && (
        <NewCategoryForm parentId={null} onDone={() => setAddingRoot(false)} />
      )}

      {tree.length === 0 && !addingRoot && (
        <p className="py-4 text-xs text-muted">
          No categories yet. Start with the broad ones — poker, studies, freelance —
          then nest as the shape becomes clear.
        </p>
      )}

      <ul>
        {tree.map((node) => (
          <CategoryRow key={node.id} node={node} taskCounts={taskCounts} />
        ))}
      </ul>
    </div>
  );
}

function CategoryRow({
  node,
  taskCounts,
}: {
  node: CategoryNode;
  taskCounts: Map<string, number>;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(node.name);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const commit = (fn: () => Promise<unknown>) => startTransition(() => void fn());
  const count = taskCounts.get(node.id) ?? 0;

  return (
    <li>
      <div
        className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-surface"
        style={{ paddingLeft: node.depth * 16 + 4 }}
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: node.effectiveColor }}
        />

        {editing ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (name.trim() && name !== node.name) {
                commit(() => updateCategory({ id: node.id, name }));
              } else {
                setName(node.name);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setName(node.name);
                setEditing(false);
              }
            }}
            className="flex-1 rounded border border-line bg-surface px-1 py-0.5 text-sm outline-none focus:border-accent"
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="flex-1 truncate text-left"
          >
            {node.name}
          </button>
        )}

        {count > 0 && (
          <span className="shrink-0 text-xs tabular-nums text-muted">{count}</span>
        )}

        <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <ColorPicker
            value={node.color}
            onChange={(color) => commit(() => updateCategory({ id: node.id, color }))}
          />
          <button
            onClick={() => setAdding((v) => !v)}
            className="rounded border border-line px-1.5 text-xs hover:border-accent"
            title="Add a child category"
          >
            +
          </button>
          <button
            onClick={() => {
              // The category is the label now, so nothing can outlive it: the
              // server refuses while anything still points here.
              if (confirm(`Delete "${node.name}" and its sub-categories?`)) {
                commit(async () => {
                  const result = await deleteCategory(node.id);
                  if (!result.ok) setError(result.error);
                });
              }
            }}
            className="rounded border border-line px-1.5 text-xs text-muted hover:border-red-500 hover:text-red-500"
          >
            ×
          </button>
        </div>
      </div>

      {error && (
        <p
          className="py-0.5 text-xs text-red-500"
          style={{ paddingLeft: node.depth * 16 + 20 }}
        >
          {error}
        </p>
      )}

      {adding && (
        <div style={{ paddingLeft: (node.depth + 1) * 16 + 4 }}>
          <NewCategoryForm parentId={node.id} onDone={() => setAdding(false)} />
        </div>
      )}

      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <CategoryRow key={child.id} node={child} taskCounts={taskCounts} />
          ))}
        </ul>
      )}
    </li>
  );
}

function NewCategoryForm({
  parentId,
  onDone,
}: {
  parentId: string | null;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="my-1 flex flex-wrap gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        const payload = { name, parentId, color: null };
        setName("");
        onDone();
        startTransition(async () => {
          await createCategory(payload);
        });
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onDone()}
        placeholder="Category name"
        className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-sm outline-none focus:border-accent"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-accent px-2 py-1 text-xs text-white disabled:opacity-50"
      >
        Add
      </button>
    </form>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (color: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded border border-line px-1.5 text-xs hover:border-accent"
        title="Color"
      >
        ●
      </button>
      {open && (
        <div className="absolute right-0 top-6 z-20 flex w-40 flex-wrap gap-1 rounded border border-line bg-surface p-2 shadow-lg">
          {PALETTE.map((color) => (
            <button
              key={color}
              onClick={() => {
                onChange(color);
                setOpen(false);
              }}
              className={`h-4 w-4 rounded-full ${value === color ? "ring-2 ring-accent" : ""}`}
              style={{ backgroundColor: color }}
            />
          ))}
          <button
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className="w-full pt-1 text-[10px] text-muted hover:text-foreground"
          >
            Inherit from parent
          </button>
        </div>
      )}
    </div>
  );
}
