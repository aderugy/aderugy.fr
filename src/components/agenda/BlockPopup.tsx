"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fmtDuration, fmtTime, minutesOfDay } from "@/lib/time";
import type { Category } from "@/lib/types";
import { eventHitsElement } from "@/lib/dom";
import { CategoryPicker } from "./CategoryPicker";

export type DraftBlock = {
  startsAt: Date;
  endsAt: Date;
  overCommitted?: boolean;
  /** Viewport coordinates of the drawn selection, for anchoring. */
  anchor: { top: number; bottom: number; left: number; right: number };
};

const POPUP_WIDTH = 264;
const GAP = 8;

/**
 * The form that opens after drawing a timeframe on the grid.
 *
 * Rendered through a portal: the grid body scrolls with `overflow-y-auto`, so a
 * popup inside it would be clipped at the edges and would slide away from its
 * anchor as soon as the grid scrolled.
 */
export function BlockPopup({
  draft,
  categories,
  defaultCategoryId,
  onCancel,
  onSubmit,
}: {
  draft: DraftBlock;
  categories: Category[];
  defaultCategoryId: string | null;
  onCancel: () => void;
  /** Resolves to an error message, or null when the block was created. */
  onSubmit: (input: {
    categoryId: string;
    description: string | null;
    startsAt: Date;
    endsAt: Date;
  }) => Promise<string | null>;
}) {
  const [categoryId, setCategoryId] = useState<string | null>(defaultCategoryId);
  const [description, setDescription] = useState("");
  const [startMin, setStartMin] = useState(minutesOfDay(draft.startsAt));
  const [endMin, setEndMin] = useState(minutesOfDay(draft.endsAt));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!eventHitsElement(e, ref.current)) onCancel();
    };
    // Deferred a tick: the pointerup that ended the drag would otherwise be
    // seen as an outside click and close the popup the instant it opens.
    const id = setTimeout(
      () => document.addEventListener("pointerdown", onPointerDown),
      0,
    );
    return () => {
      clearTimeout(id);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onCancel]);

  // Safe to touch `window` here: the parent renders this only once a drag has
  // happened, which cannot occur during server rendering.
  //
  // Anchoring by a guessed height put the buttons below the fold when the
  // selection sat low on screen — the form looked like it did nothing because
  // Add was off-screen. Growing upward from the selection instead needs no
  // measurement, and the max-height keeps it inside the viewport regardless.
  // On a phone the anchor column is most of the screen, so there is no "beside
  // the selection" to sit in: the form takes the width it can get and is
  // centred under the finger instead.
  const width = Math.min(POPUP_WIDTH, window.innerWidth - 2 * GAP);
  const preferred =
    draft.anchor.right + GAP + width <= window.innerWidth - GAP
      ? draft.anchor.right + GAP
      : draft.anchor.left - GAP - width;
  const left = Math.max(GAP, Math.min(preferred, window.innerWidth - width - GAP));
  const growUpward = draft.anchor.top > window.innerHeight * 0.55;
  const vertical = growUpward
    ? { bottom: Math.max(GAP, window.innerHeight - draft.anchor.bottom) }
    : { top: Math.max(GAP, draft.anchor.top) };

  async function submit() {
    if (saving) return;
    if (!categoryId) {
      setError("Pick a category");
      return;
    }
    if (endMin <= startMin) {
      setError("End must be after start");
      return;
    }
    const startsAt = new Date(draft.startsAt);
    startsAt.setHours(0, startMin, 0, 0);
    const endsAt = new Date(draft.startsAt);
    endsAt.setHours(0, endMin, 0, 0);

    setSaving(true);
    setError(null);
    // Stay open and say so if the write failed. Closing regardless is how a
    // rejected insert turns into "nothing happened".
    const failure = await onSubmit({
      categoryId,
      description: description.trim() || null,
      startsAt,
      endsAt,
    });
    if (failure) {
      setError(failure);
      setSaving(false);
    }
  }

  return createPortal(
    <div
      ref={ref}
      style={{
        position: "fixed",
        left,
        width,
        maxHeight: "calc(100dvh - 16px)",
        overflowY: "auto",
        ...vertical,
      }}
      className="z-50 rounded-lg border border-line bg-surface p-3 text-xs shadow-xl"
      onKeyDown={(e) => {
        // Ctrl/Cmd+Enter saves from anywhere, including the description.
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-medium">
          {draft.startsAt.toLocaleDateString(undefined, {
            weekday: "long",
            day: "numeric",
            month: "short",
          })}
        </span>
        <span className="tabular-nums text-muted">
          {fmtDuration(Math.max(0, endMin - startMin))}
        </span>
      </div>

      <label className="block">
        <span className="text-muted">Category</span>
        <div className="mt-1">
          <CategoryPicker
            categories={categories}
            value={categoryId}
            onChange={(id) => {
              setCategoryId(id);
              setError(null);
            }}
            autoFocus
          />
        </div>
      </label>

      <label className="mt-2 block">
        <span className="text-muted">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="What this session actually covers"
          className="mt-1 w-full resize-none rounded border border-line bg-surface px-2 py-1 outline-none focus:border-accent"
        />
      </label>

      <div className="mt-2 flex items-center gap-2">
        <TimeField value={startMin} onChange={setStartMin} />
        <span className="text-muted">→</span>
        <TimeField value={endMin} onChange={setEndMin} />
      </div>

      {draft.overCommitted && (
        <p className="mt-2 text-amber-600 dark:text-amber-500">
          Overlaps time one of your calendars has already committed.
        </p>
      )}

      {error && <p className="mt-2 text-red-500">{error}</p>}

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded border border-line px-2 py-1 text-muted hover:text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          className="rounded bg-accent px-3 py-1 font-medium text-white disabled:opacity-60"
        >
          {saving ? "Adding…" : "Add"}
        </button>
      </div>
    </div>,
    document.body,
  );
}

function TimeField({
  value,
  onChange,
}: {
  value: number;
  onChange: (minutes: number) => void;
}) {
  return (
    <input
      type="time"
      step={900}
      value={fmtTime(value)}
      onChange={(e) => {
        const [h, m] = e.target.value.split(":").map(Number);
        if (Number.isFinite(h) && Number.isFinite(m)) onChange(h * 60 + m);
      }}
      className="flex-1 rounded border border-line bg-surface px-1 py-1 tabular-nums outline-none focus:border-accent"
    />
  );
}
