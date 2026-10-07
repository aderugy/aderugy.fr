"use client";

import { useState } from "react";
import { ErrorLine, TagChip } from "@/components/jobs/bits";
import { InlineText, useAction } from "@/components/jobs/controls";
import { DEFAULT_COLOR, PALETTE } from "@/lib/categories";
import type { LiveTag } from "@/lib/live/types";
import { createTag, deleteTag, updateTag } from "@/server/actions/live";

/** Player tags: fish, reg, nit, maniac… Flat on purpose: a player carries several. */
export function LiveTagManager({ tags, counts }: { tags: LiveTag[]; counts: Record<string, number> }) {
  const { pending, error, run } = useAction();
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE[tags.length % PALETTE.length]);
  const [confirming, setConfirming] = useState<string | null>(null);

  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= tags.length) return;
    const order = [...tags];
    [order[i], order[j]] = [order[j], order[i]];
    run(async () => {
      // Positions may tie (several 0s): rewrite every one from the new order.
      for (const [position, tag] of order.entries()) {
        if (tag.position === position) continue;
        const r = await updateTag(tag.id, { position });
        if (!r.ok) return r;
      }
      return { ok: true as const };
    });
  };

  return (
    <main className={`mx-auto h-full w-full max-w-xl overflow-y-auto px-4 py-6 sm:px-6 sm:py-8 ${pending ? "opacity-80" : ""}`}>
      <h1 className="text-lg font-semibold tracking-tight">Tags</h1>
      <p className="mt-1 text-xs text-muted">How you read a player: fish, reg, nit, maniac, calling station… A player can carry several, and their colours show on the table.</p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(() => createTag({ name, color }), () => {
            setName("");
            setColor(PALETTE[(tags.length + 1) % PALETTE.length]);
          });
        }}
        className="mt-4 flex items-center gap-2"
      >
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-7 w-7 shrink-0 rounded border border-line bg-transparent" />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New tag"
          className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-sm outline-none focus:border-accent"
        />
        <button type="submit" disabled={!name.trim()} className="rounded bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50">
          Add
        </button>
      </form>
      <ErrorLine error={error} />

      <ul className="mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
        {tags.map((t, i) => (
          <li key={t.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <input
              type="color"
              value={t.color ?? DEFAULT_COLOR}
              onChange={(e) => run(() => updateTag(t.id, { color: e.target.value }))}
              className="h-5 w-5 shrink-0 rounded border border-line bg-transparent"
              aria-label={`Colour of ${t.name}`}
            />
            <InlineText value={t.name} onSave={(v) => run(() => updateTag(t.id, { name: v }))} className="min-w-0 flex-1" />
            <span className="text-xs text-muted tabular-nums">{counts[t.id] ?? 0}</span>
            <span className="flex text-xs text-muted">
              <button onClick={() => move(i, -1)} disabled={i === 0} className="px-1 hover:text-foreground disabled:opacity-30" aria-label="Move up">
                ↑
              </button>
              <button onClick={() => move(i, 1)} disabled={i === tags.length - 1} className="px-1 hover:text-foreground disabled:opacity-30" aria-label="Move down">
                ↓
              </button>
            </span>
            {confirming === t.id ? (
              <span className="flex gap-2 text-xs">
                <button onClick={() => setConfirming(null)} className="text-muted">
                  Keep
                </button>
                <button onClick={() => run(() => deleteTag(t.id), () => setConfirming(null))} className="text-red-500">
                  Delete{counts[t.id] ? ` from ${counts[t.id]}` : ""}
                </button>
              </span>
            ) : (
              <button onClick={() => setConfirming(t.id)} className="text-xs text-muted hover:text-red-500">
                Delete
              </button>
            )}
          </li>
        ))}
        {tags.length === 0 && <li className="px-3 py-6 text-center text-xs text-muted">No tags yet.</li>}
      </ul>
      {tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1">
          {tags.map((t) => (
            <TagChip key={t.id} tag={t} />
          ))}
        </div>
      )}
    </main>
  );
}
