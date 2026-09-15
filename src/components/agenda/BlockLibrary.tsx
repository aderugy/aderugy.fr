"use client";

import { useMemo, useState, useTransition } from "react";
import { buildTree, flattenTree, PALETTE, DEFAULT_COLOR } from "@/lib/categories";
import { fmtDuration } from "@/lib/time";
import type { Block, Category } from "@/lib/types";
import {
  addBlockItem,
  createBlock,
  deleteBlock,
  deleteBlockItem,
  updateBlock,
} from "@/server/actions/blocks";

export function BlockLibrary({
  categories,
  blocks,
}: {
  categories: Category[];
  blocks: Block[];
}) {
  const flat = useMemo(() => flattenTree(buildTree(categories)), [categories]);

  return (
    <div className="text-sm">
      <h2 className="font-medium">Reusable blocks</h2>
      <p className="mt-1 text-xs text-muted">
        A block with no steps is a shape — a named slot you drop on the week. Add
        steps and it becomes a bundle, sized to the sum of its parts.
      </p>

      <NewBlockForm categories={flat} />

      <ul className="mt-4 space-y-2">
        {blocks.length === 0 && (
          <li className="py-6 text-center text-xs text-muted">No blocks yet.</li>
        )}
        {blocks.map((block) => (
          <BlockCard key={block.id} block={block} categories={flat} />
        ))}
      </ul>
    </div>
  );
}

type FlatCategory = { id: string; name: string; depth: number; effectiveColor: string };

function BlockCard({
  block,
  categories,
}: {
  block: Block;
  categories: FlatCategory[];
}) {
  const [, startTransition] = useTransition();
  const commit = (fn: () => Promise<unknown>) => startTransition(() => void fn());

  const items = [...block.block_items].sort((a, b) => a.position - b.position);
  const itemMinutes = items.reduce((sum, i) => sum + i.estimated_minutes, 0);
  const minutes = itemMinutes > 0 ? itemMinutes : block.default_minutes;
  const categoryColor = categories.find(
    (c) => c.id === block.default_category_id,
  )?.effectiveColor;
  const color = block.color ?? categoryColor ?? DEFAULT_COLOR;

  return (
    <li
      className="rounded border border-line bg-surface p-3"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          defaultValue={block.name}
          onBlur={(e) => {
            if (e.target.value.trim() && e.target.value !== block.name) {
              commit(() => updateBlock({ id: block.id, name: e.target.value }));
            }
          }}
          className="min-w-32 flex-1 bg-transparent font-medium outline-none max-sm:min-w-0 max-sm:basis-full"
        />

        <span className="text-xs tabular-nums text-muted">{fmtDuration(minutes)}</span>

        {items.length === 0 && (
          <input
            type="number"
            min={5}
            step={5}
            defaultValue={block.default_minutes}
            onBlur={(e) =>
              commit(() =>
                updateBlock({ id: block.id, defaultMinutes: Number(e.target.value) }),
              )
            }
            title="Default duration in minutes"
            className="w-16 rounded border border-line bg-surface px-1 py-0.5 text-xs tabular-nums outline-none focus:border-accent"
          />
        )}

        <select
          value={block.default_category_id ?? ""}
          onChange={(e) =>
            commit(() =>
              updateBlock({
                id: block.id,
                defaultCategoryId: e.target.value || null,
              }),
            )
          }
          className="rounded border border-line bg-surface px-1 py-0.5 text-xs outline-none focus:border-accent"
        >
          <option value="">No category</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {"— ".repeat(c.depth)}
              {c.name}
            </option>
          ))}
        </select>

        <select
          value={block.preferred_daypart ?? ""}
          onChange={(e) =>
            commit(() =>
              updateBlock({
                id: block.id,
                preferredDaypart:
                  (e.target.value || null) as Block["preferred_daypart"],
              }),
            )
          }
          className="rounded border border-line bg-surface px-1 py-0.5 text-xs outline-none focus:border-accent"
        >
          <option value="">Any time</option>
          <option value="morning">Morning</option>
          <option value="afternoon">Afternoon</option>
          <option value="evening">Evening</option>
        </select>

        <select
          value={block.color ?? ""}
          onChange={(e) =>
            commit(() => updateBlock({ id: block.id, color: e.target.value || null }))
          }
          className="rounded border border-line bg-surface px-1 py-0.5 text-xs outline-none focus:border-accent"
        >
          <option value="">Category color</option>
          {PALETTE.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <button
          onClick={() => {
            if (confirm(`Delete the block "${block.name}"?`)) {
              commit(() => deleteBlock(block.id));
            }
          }}
          className="rounded border border-line px-1.5 py-0.5 text-xs text-muted hover:border-red-500 hover:text-red-500"
        >
          ×
        </button>
      </div>

      {items.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-line pt-2">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-2 text-xs">
              <span className="flex-1 truncate">{item.label}</span>
              <span className="tabular-nums text-muted">
                {fmtDuration(item.estimated_minutes)}
              </span>
              <button
                onClick={() => commit(() => deleteBlockItem(item.id))}
                className="text-muted hover:text-red-500"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <NewItemForm blockId={block.id} categories={categories} />
    </li>
  );
}

function NewItemForm({
  blockId,
  categories,
}: {
  blockId: string;
  categories: FlatCategory[];
}) {
  const [label, setLabel] = useState("");
  const [minutes, setMinutes] = useState(15);
  const [categoryId, setCategoryId] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="mt-2 flex flex-wrap gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!label.trim()) return;
        const payload = {
          blockId,
          label,
          estimatedMinutes: minutes,
          categoryId: categoryId || null,
        };
        setLabel("");
        startTransition(async () => {
          await addBlockItem(payload);
        });
      }}
    >
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Add a step…"
        className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-xs outline-none focus:border-accent max-sm:basis-full"
      />
      <input
        type="number"
        min={5}
        step={5}
        value={minutes}
        onChange={(e) => setMinutes(Number(e.target.value))}
        className="w-14 rounded border border-line bg-surface px-1 py-1 text-xs tabular-nums outline-none focus:border-accent"
      />
      <select
        value={categoryId}
        onChange={(e) => setCategoryId(e.target.value)}
        className="w-20 rounded border border-line bg-surface px-1 py-1 text-xs outline-none focus:border-accent"
      >
        <option value="">—</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-line px-2 py-1 text-xs hover:border-accent disabled:opacity-50"
      >
        +
      </button>
    </form>
  );
}

function NewBlockForm({ categories }: { categories: FlatCategory[] }) {
  const [name, setName] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [categoryId, setCategoryId] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="mt-4 flex flex-wrap gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        const payload = {
          name,
          defaultMinutes: minutes,
          defaultCategoryId: categoryId || null,
          color: null,
          preferredDaypart: null,
        };
        setName("");
        startTransition(async () => {
          await createBlock(payload);
        });
      }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New block — e.g. Deep work"
        className="min-w-40 flex-1 rounded border border-line bg-surface px-2 py-1 text-sm outline-none focus:border-accent max-sm:min-w-0 max-sm:basis-full"
      />
      <input
        type="number"
        min={5}
        step={5}
        value={minutes}
        onChange={(e) => setMinutes(Number(e.target.value))}
        className="w-16 rounded border border-line bg-surface px-1 py-1 text-xs tabular-nums outline-none focus:border-accent"
      />
      <select
        value={categoryId}
        onChange={(e) => setCategoryId(e.target.value)}
        className="rounded border border-line bg-surface px-1 py-1 text-xs outline-none focus:border-accent"
      >
        <option value="">No category</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {"— ".repeat(c.depth)}
            {c.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50"
      >
        Add
      </button>
    </form>
  );
}
