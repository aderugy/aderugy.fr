"use client";

import { useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { fmtMinutes, overrunRatio } from "@/lib/projects/clock";
import { compareSteps, type StepWithSpent } from "@/lib/projects/types";
import type { ProjectState } from "@/server/projects/data";
import { closeStep } from "@/server/actions/projects";
import { btnPrimary, input, useAction } from "./bits";

export function CloseStepSheet({
  state,
  step,
  onClose,
}: {
  state: ProjectState;
  step: StepWithSpent;
  onClose: () => void;
}) {
  const after = [...state.steps].sort(compareSteps);
  const todo = after.filter((s) => s.status === "todo");
  const nextInPlan = after.slice(after.findIndex((s) => s.id === step.id) + 1).find((s) => s.status === "todo") ?? todo[0] ?? null;
  const openTodos = state.items.filter((i) => i.step_id === step.id && i.status === "open");

  const spent = step.totals.spent;
  const [outcome, setOutcome] = useState<"done" | "cut">(spent >= step.cut_minutes ? "cut" : "done");
  const [note, setNote] = useState("");
  const [nextId, setNextId] = useState<string>(nextInPlan?.id ?? "");
  const [park, setPark] = useState(openTodos.length > 0);
  const { pending, error, run } = useAction();

  return (
    <Sheet
      title={`Fermer ${step.code} ${step.title}`}
      onClose={onClose}
      footer={
        <button
          type="button"
          disabled={pending || !note.trim()}
          onClick={() =>
            run(
              () =>
                closeStep({
                  projectId: state.project.id,
                  stepId: step.id,
                  outcome,
                  note,
                  nextStepId: nextId || null,
                  parkTodos: park,
                  blocksStepId: nextId || nextInPlan?.id || null,
                }),
              onClose,
            )
          }
          className={`w-full ${btnPrimary}`}
        >
          Fermer{nextId ? ` et ouvrir ${state.steps.find((s) => s.id === nextId)?.code}` : ""}
        </button>
      }
    >
      <p className="text-sm text-muted">
        {fmtMinutes(spent)} pour un budget de {fmtMinutes(step.budget_minutes)} — ratio{" "}
        <span className="font-medium text-foreground">{overrunRatio(spent, step.budget_minutes).toFixed(2)}</span>
      </p>

      <fieldset className="mt-4 flex gap-2">
        {(
          [
            ["done", "Faite", "le critère « assez bien » est atteint"],
            ["cut", "Coupée", "version minimale, à la ligne de coupe"],
          ] as const
        ).map(([value, label, hint]) => (
          <label
            key={value}
            className={`flex-1 cursor-pointer rounded border p-2 text-sm ${outcome === value ? "border-accent bg-accent/10" : "border-line"}`}
          >
            <input type="radio" name="outcome" value={value} checked={outcome === value} onChange={() => setOutcome(value)} className="sr-only" />
            <span className="font-medium">{label}</span>
            <span className="block text-xs text-muted">{hint}</span>
          </label>
        ))}
      </fieldset>

      <label className="mt-4 block text-xs text-muted">
        En une ligne : ce qui est livré, ce qui est laissé
        <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className={`mt-1 ${input}`} />
      </label>

      <label className="mt-4 block text-xs text-muted">
        Ouvrir ensuite
        <select value={nextId} onChange={(e) => setNextId(e.target.value)} className={`mt-1 ${input}`}>
          <option value="">— aucune pour l&apos;instant</option>
          {todo.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} {s.title}
            </option>
          ))}
        </select>
      </label>

      {openTodos.length > 0 && (
        <label className="mt-4 flex items-start gap-2 text-sm">
          <input type="checkbox" checked={park} onChange={(e) => setPark(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
          <span>
            Garer les {openTodos.length} tâche{openTodos.length > 1 ? "s" : ""} encore ouverte{openTodos.length > 1 ? "s" : ""}
            {nextId || nextInPlan ? ` (bloquent ${state.steps.find((s) => s.id === (nextId || nextInPlan?.id))?.code})` : ""}
            <span className="block text-xs text-muted">{openTodos.map((i) => i.title).join(" · ")}</span>
          </span>
        </label>
      )}
      {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
    </Sheet>
  );
}
