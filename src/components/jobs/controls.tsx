"use client";

import { useState, useTransition, type ReactNode } from "react";
import type { ActionResult } from "@/server/auth";

export function Section({
  title,
  aside,
  children,
  id,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="flex-1 text-xs font-medium tracking-wide text-muted uppercase">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Runs an action, keeps its error, and greys the caller out while it runs. */
export function useAction() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionResult | { ok: boolean; error?: string }>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(("error" in r && r.error) || "Something went wrong");
      else after?.();
    });
  };
  return { pending, error, run, setError };
}

/** Text shown as-is until clicked; Enter or blur saves, Esc cancels. */
export function InlineText({
  value,
  onSave,
  className = "",
  placeholder = "",
  type = "text",
}: {
  value: string;
  onSave: (next: string) => void;
  className?: string;
  placeholder?: string;
  type?: "text" | "url" | "date";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        className={`text-left hover:text-accent ${value ? "" : "text-muted"} ${className}`}
        title="Edit"
      >
        {value || placeholder}
      </button>
    );
  }
  const save = () => {
    setEditing(false);
    if (draft.trim() !== value) onSave(draft.trim());
  };
  return (
    <input
      autoFocus
      type={type}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") setEditing(false);
      }}
      placeholder={placeholder}
      className={`rounded border border-accent bg-background px-1 outline-none ${className}`}
    />
  );
}
