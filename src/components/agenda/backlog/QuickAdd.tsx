"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { CategoryNode } from "@/lib/categories";
import type { Category } from "@/lib/types";
import { parseQuickAdd } from "@/lib/agenda/ranking";
import { eventHitsElement } from "@/lib/dom";
import { fmtDuration } from "@/lib/time";
import { createTask } from "@/server/actions/tasks";
import { CategoryPicker } from "../CategoryPicker";
import { PRIORITY_STYLE } from "./shared";

const DEFAULT_MINUTES = 30;

/**
 * One line to capture a task without breaking stride: the category sits on
 * the left (it follows the category filter, so filtering to "poker > grind"
 * and typing adds to it), shortcuts in the text set the rest — "45m", "1h30",
 * "!1".."!4". Deadline and notes are for the editor, once it exists.
 */
export function QuickAdd({
  categories,
  byId,
  categoryId,
  onCategoryChange,
}: {
  categories: Category[];
  byId: Map<string, CategoryNode>;
  categoryId: string | null;
  onCategoryChange: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const category = categoryId ? (byId.get(categoryId) ?? null) : null;
  const parsed = parseQuickAdd(text);

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!eventHitsElement(e, pickerRef.current)) setPickerOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pickerOpen]);

  function submit() {
    if (!text.trim()) return;
    if (!category) {
      setPickerOpen(true);
      setError("Pick a category first.");
      return;
    }
    const typed = text;
    const payload = {
      categoryId: category.id,
      description: parsed.description.trim() || null,
      estimatedMinutes: parsed.minutes ?? DEFAULT_MINUTES,
      priority: parsed.priority ?? 3,
      deadline: null,
    };
    setText("");
    setError(null);
    startTransition(async () => {
      const result = await createTask(payload);
      if (!result.ok) {
        // Give the text back rather than losing it with the failed save.
        setText(typed);
        setError(result.error);
      }
    });
    inputRef.current?.focus();
  }

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-stretch gap-0 rounded-lg border border-line bg-surface focus-within:border-accent"
      >
        <div ref={pickerRef} className="relative flex shrink-0">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            aria-expanded={pickerOpen}
            title={category?.path ?? "Pick a category"}
            className="flex max-w-[9rem] items-center gap-1.5 rounded-l-lg border-r border-line px-2.5 text-xs hover:bg-background sm:max-w-[12rem]"
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: category?.effectiveColor ?? "transparent" }}
            />
            <span className={`truncate ${category ? "" : "text-muted"}`}>
              {category?.name ?? "Category"}
            </span>
            <span className="text-[9px] text-muted" aria-hidden>
              ▾
            </span>
          </button>
          {pickerOpen && (
            <div className="absolute left-0 top-full z-40 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface p-2 shadow-xl">
              <CategoryPicker
                categories={categories}
                value={categoryId}
                autoFocus
                onChange={(id) => {
                  onCategoryChange(id);
                  setPickerOpen(false);
                  setError(null);
                  inputRef.current?.focus();
                }}
              />
            </div>
          )}
        </div>

        <input
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          placeholder="Add a task…  45m  !2"
          enterKeyHint="done"
          className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-base outline-none placeholder:text-muted sm:text-sm"
        />
        <button
          type="submit"
          disabled={pending || !text.trim()}
          aria-label="Add task"
          className="m-1 shrink-0 rounded-md bg-accent px-3 text-sm font-medium text-white disabled:opacity-30"
        >
          +
        </button>
      </form>

      {(text.trim() || error) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted">
          {error ? (
            <span className="text-red-500">{error}</span>
          ) : (
            <>
              <span>{fmtDuration(parsed.minutes ?? DEFAULT_MINUTES)}</span>
              <span style={{ color: parsed.priority && parsed.priority <= 2 ? PRIORITY_STYLE[parsed.priority].color : undefined }}>
                {PRIORITY_STYLE[parsed.priority ?? 3].label}
              </span>
              <span className="hidden sm:inline">Enter to add · edit the rest after</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
