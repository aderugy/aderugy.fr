"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CategoryPicker } from "@/components/agenda/CategoryPicker";
import { ErrorLine } from "./bits";
import { Section, useAction } from "./controls";
import { categoryIndex } from "@/lib/categories";
import { fmtDate, toLocalInput } from "@/lib/jobs/format";
import { KIND_LABELS, type ApplicationDetail } from "@/lib/jobs/types";
import { PRIORITY_LABELS, type Category } from "@/lib/types";
import { createApplicationTask } from "@/server/actions/jobs";
import { updateTask } from "@/server/actions/tasks";

/**
 * Backlog tasks that belong to this application. They are ordinary tasks —
 * on the backlog, planned on the grid — this is only the view from here.
 */
export function LinkedTasks({ app, categories, now }: { app: ApplicationDetail; categories: Category[]; now: string }) {
  const { pending, error, run } = useAction();
  const [adding, setAdding] = useState(false);
  const index = useMemo(() => categoryIndex(categories), [categories]);
  const open = app.tasks.filter((t) => t.status === "backlog" || t.status === "scheduled");
  const closed = app.tasks.filter((t) => t.status === "done" || t.status === "dropped");

  return (
    <Section
      title="Tasks"
      aside={
        !adding && (
          <button onClick={() => setAdding(true)} className="text-xs text-accent hover:underline">
            + Task
          </button>
        )
      }
    >
      {adding && <NewTask app={app} categories={categories} now={now} onDone={() => setAdding(false)} />}
      {app.tasks.length === 0 && !adding && (
        <p className="text-xs text-muted">Prep, a follow-up email, the cover letter: they land in the backlog, linked here.</p>
      )}
      <ul className={`space-y-1 text-xs ${pending ? "opacity-60" : ""}`}>
        {[...open, ...closed].map((t) => {
          const cat = index.get(t.category_id);
          const done = t.status === "done";
          return (
            <li key={t.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={done}
                disabled={t.status === "dropped"}
                onChange={() => run(() => updateTask({ id: t.id, status: done ? "backlog" : "done" }))}
                title={done ? "Reopen" : "Mark done"}
              />
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: cat?.color ?? "#64748b" }}
                title={cat?.name}
              />
              <span className={`min-w-0 flex-1 truncate ${done || t.status === "dropped" ? "text-muted line-through" : ""}`}>
                {t.description || cat?.name || "Task"}
              </span>
              <span className="shrink-0 text-muted tabular-nums">
                {t.status === "scheduled" ? "on the grid · " : ""}
                {t.deadline ? `due ${fmtDate(t.deadline.slice(0, 10))} · ` : ""}
                {t.estimated_minutes} min
              </span>
            </li>
          );
        })}
      </ul>
      {open.length > 0 && (
        <Link href="/agenda" className="mt-2 inline-block text-xs text-muted hover:text-foreground">
          Plan them on the week →
        </Link>
      )}
      <ErrorLine error={error} />
    </Section>
  );
}

function NewTask({
  app,
  categories,
  now,
  onDone,
}: {
  app: ApplicationDetail;
  categories: Category[];
  now: string;
  onDone: () => void;
}) {
  const { pending, error, run, setError } = useAction();
  const next = app.interviews.find((i) => Date.parse(i.ends_at) > Date.parse(now));
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [description, setDescription] = useState(
    next
      ? `Prepare ${app.company.name} ${KIND_LABELS[next.kind].toLowerCase()} interview`
      : app.status === "to_apply"
        ? `Apply to ${app.company.name}`
        : `Follow up with ${app.company.name}`,
  );
  const [minutes, setMinutes] = useState(60);
  const [priority, setPriority] = useState(2);
  const [deadline, setDeadline] = useState(
    next ? toLocalInput(next.starts_at).slice(0, 10) : (app.status === "to_apply" ? app.deadline : null) ?? "",
  );

  const field = "rounded border border-line bg-background px-2 py-1 text-xs outline-none focus:border-accent";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!categoryId) return setError("Pick a category.");
        run(
          () =>
            createApplicationTask({
              applicationId: app.id,
              categoryId,
              description: description || null,
              estimatedMinutes: minutes,
              priority,
              deadline: deadline || null,
            }),
          onDone,
        );
      }}
      className="mb-3 grid gap-2 rounded border border-line bg-background/50 p-3 text-xs"
    >
      <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} autoFocus />
      <input value={description} onChange={(e) => setDescription(e.target.value)} className={field} placeholder="What exactly" />
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="number"
          min={5}
          max={1440}
          step={5}
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
          className={`${field} w-20`}
        />
        <span className="text-muted">min</span>
        <select value={priority} onChange={(e) => setPriority(Number(e.target.value))} className={field}>
          {[1, 2, 3, 4].map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
        <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} className={field} />
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className="rounded bg-accent px-2.5 py-1 font-medium text-white disabled:opacity-50">
          Add to backlog
        </button>
        <button type="button" onClick={onDone} className="text-muted hover:text-foreground">
          Cancel
        </button>
        <ErrorLine error={error} />
      </div>
    </form>
  );
}
