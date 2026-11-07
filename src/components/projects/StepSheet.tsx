"use client";

import { useEffect, useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { clockOf, defaultCut, fmtMinutes, overrunRatio, parseMinutes } from "@/lib/projects/clock";
import { fmtWhenFr } from "@/lib/projects/format";
import { SOURCE_LABELS, STEP_STATUS_LABELS, type StepWithSpent, type WorkEntry } from "@/lib/projects/types";
import type { ProjectState } from "@/server/projects/data";
import {
  logWork,
  removeStep,
  renameStepCode,
  saveStep,
  setStepStatus,
  stepWork,
} from "@/server/actions/projects";
import { ConfirmButton, btn, btnPrimary, input, sortItems, useAction } from "./bits";
import { stateTone } from "./tone";

/**
 * One step: create it, or edit it (Arthur edits budget, cut line and status
 * here — Claude can't once the step is opened), see its time by source, its
 * work log and its items.
 */
export function StepSheet({
  state,
  step,
  onClose,
}: {
  state: ProjectState;
  step: StepWithSpent | null;
  onClose: () => void;
}) {
  const isNew = step === null;
  const lastMilestone = [...state.steps].reverse().find((s) => s.milestone)?.milestone ?? "";
  const [code, setCode] = useState(step?.code ?? "");
  const [milestone, setMilestone] = useState(step?.milestone ?? lastMilestone);
  const [title, setTitle] = useState(step?.title ?? "");
  const [goodEnough, setGoodEnough] = useState(step?.good_enough ?? "");
  const [budget, setBudget] = useState(step ? fmtMinutes(step.budget_minutes) : "");
  const [cut, setCut] = useState(step ? fmtMinutes(step.cut_minutes) : "");
  const { pending, error, run } = useAction();

  const budgetMin = parseMinutes(budget.replace(/\s*min$/, ""));
  const cutMin = cut.trim() ? parseMinutes(cut.replace(/\s*min$/, "")) : null;

  const save = () =>
    run(async () => {
      if (!budgetMin) return { ok: false, error: "Budget : une durée, par ex. 2h ou 90." };
      if (step && code.trim() !== step.code) {
        const r = await renameStepCode(step.id, code);
        if (!r.ok) return r;
      }
      return saveStep(state.project.id, {
        code: code.trim(),
        milestone: milestone || null,
        title,
        good_enough: goodEnough || null,
        budget_minutes: budgetMin,
        cut_minutes: cutMin ?? (isNew ? null : defaultCut(budgetMin)),
      });
    }, onClose);

  const changeStatus = (s: Parameters<typeof setStepStatus>[1]) => run(() => setStepStatus(step!.id, s), onClose);

  return (
    <Sheet
      title={isNew ? "Nouvelle étape" : `${step.code} ${step.title}`}
      onClose={onClose}
      wide
      footer={
        <div className="flex items-center gap-2">
          {!isNew && (
            <ConfirmButton
              label="Supprimer"
              confirmLabel="Supprimer l'étape"
              disabled={pending}
              onConfirm={() => run(() => removeStep(step.id), onClose)}
            />
          )}
          <button type="button" disabled={pending || !code.trim() || !title.trim() || !budgetMin} onClick={save} className={`ml-auto ${btnPrimary}`}>
            {isNew ? "Ajouter" : "Enregistrer"}
          </button>
        </div>
      }
    >
      {step && <StepClock step={step} />}

      <div className="mt-3 grid grid-cols-3 gap-2">
        <label className="text-xs text-muted">
          Code
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="2.1" maxLength={12} className={`mt-1 font-mono ${input}`} />
        </label>
        <label className="col-span-2 text-xs text-muted">
          Jalon
          <input value={milestone} onChange={(e) => setMilestone(e.target.value)} placeholder="Jalon 2" maxLength={60} className={`mt-1 ${input}`} />
        </label>
      </div>
      <label className="mt-2 block text-xs text-muted">
        Titre
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={`mt-1 ${input}`} />
      </label>
      <label className="mt-2 block text-xs text-muted">
        Assez bien quand…
        <textarea value={goodEnough} onChange={(e) => setGoodEnough(e.target.value)} maxLength={500} rows={2} className={`mt-1 ${input}`} />
      </label>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="text-xs text-muted">
          Budget
          <input value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="2h" className={`mt-1 ${input}`} />
        </label>
        <label className="text-xs text-muted">
          Ligne de coupe
          <input
            value={cut}
            onChange={(e) => setCut(e.target.value)}
            placeholder={budgetMin ? `${fmtMinutes(defaultCut(budgetMin))} (1,5 ×)` : "1,5 × budget"}
            className={`mt-1 ${input}`}
          />
        </label>
      </div>

      {step && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-xs text-muted">Statut : {STEP_STATUS_LABELS[step.status]}</span>
            {step.status !== "open" && step.status !== "dropped" && state.project.status === "active" && (
              <button type="button" disabled={pending} onClick={() => changeStatus("open")} className={btn}>
                {step.status === "todo" ? "Ouvrir" : "Rouvrir"}
              </button>
            )}
            {step.status !== "todo" && (
              <button type="button" disabled={pending} onClick={() => changeStatus("todo")} className={btn}>
                Remettre à faire
              </button>
            )}
            {step.status !== "dropped" && (
              <button type="button" disabled={pending} onClick={() => changeStatus("dropped")} className={btn}>
                Abandonner
              </button>
            )}
          </div>
          {step.close_note && <p className="mt-2 text-sm">Clôture : {step.close_note}</p>}
          <StepItems state={state} stepId={step.id} />
          <WorkLog step={step} />
        </>
      )}
      {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
    </Sheet>
  );
}

function StepClock({ step }: { step: StepWithSpent }) {
  const c = clockOf(step.totals.spent, step.budget_minutes, step.cut_minutes);
  const closed = step.status === "done" || step.status === "cut";
  const t = step.totals;
  return (
    <div className="rounded bg-surface p-2 text-sm">
      <span className="font-medium tabular-nums">
        {fmtMinutes(c.spent)} / {fmtMinutes(c.budget)}
      </span>
      <span className="text-muted"> · cut {fmtMinutes(c.cut)}</span>
      {closed ? (
        <span className="text-muted"> · ratio {overrunRatio(c.spent, c.budget).toFixed(2)}</span>
      ) : step.status === "open" ? (
        <span className={stateTone(c.state).text}> · {stateTone(c.state).label}</span>
      ) : null}
      <div className="mt-1 text-xs text-muted">
        {(["claude_code", "claude_ai", "app", "reported"] as const)
          .filter((k) => t[k])
          .map((k) => `${SOURCE_LABELS[k]} ${fmtMinutes(t[k])}`)
          .join(" · ") || "Aucun temps enregistré."}
      </div>
    </div>
  );
}

function StepItems({ state, stepId }: { state: ProjectState; stepId: string }) {
  const items = sortItems(state.items.filter((i) => i.step_id === stepId || i.blocks_step_id === stepId));
  if (!items.length) return null;
  return (
    <div className="mt-4">
      <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Éléments</h3>
      <ul className="mt-1 space-y-0.5 text-sm">
        {items.map((i) => (
          <li key={i.id} className={i.status !== "open" ? "text-muted line-through" : ""}>
            {i.kind === "park" ? "⧗ garé, bloque cette étape — " : i.status === "done" ? "☑ " : "☐ "}
            {i.title}
          </li>
        ))}
      </ul>
    </div>
  );
}

function WorkLog({ step }: { step: StepWithSpent }) {
  const [entries, setEntries] = useState<WorkEntry[] | null>(null);
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");
  const [reported, setReported] = useState(false);
  const { pending, error, run } = useAction();

  const spent = step.totals.spent;
  useEffect(() => {
    let live = true;
    stepWork(step.id).then((r) => {
      if (live && r.ok) setEntries(r.value);
    });
    return () => {
      live = false;
    };
    // Reload when the total moves (an entry was added).
  }, [step.id, spent]);

  const m = parseMinutes(minutes);
  return (
    <div className="mt-4">
      <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Journal du temps</h3>
      <form
        className="mt-2 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!m) return;
          run(() => logWork(step.id, m, note || undefined, reported), () => {
            setMinutes("");
            setNote("");
          });
        }}
      >
        <input value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="+30, -15" className="w-20 rounded border border-line bg-background px-2 py-1 text-sm" />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (correction : dire quoi)" maxLength={300} className="min-w-0 flex-1 rounded border border-line bg-background px-2 py-1 text-sm" />
        <label className="flex items-center gap-1 text-xs text-muted">
          <input type="checkbox" checked={reported} onChange={(e) => setReported(e.target.checked)} className="accent-[var(--accent)]" />
          hors app
        </label>
        <button disabled={pending || !m} className={btn}>
          Ajouter
        </button>
      </form>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      <ul className="mt-2 space-y-0.5 text-xs">
        {entries === null && <li className="text-muted">…</li>}
        {entries?.length === 0 && <li className="text-muted">Aucune entrée.</li>}
        {entries?.map((e) => (
          <li key={e.id} className="flex gap-2">
            <span className="w-28 shrink-0 text-muted">{fmtWhenFr(e.at)}</span>
            <span className={`w-14 shrink-0 text-right tabular-nums ${e.minutes < 0 ? "text-red-500" : ""}`}>
              {e.minutes > 0 ? "+" : ""}
              {fmtMinutes(e.minutes)}
            </span>
            <span className="shrink-0 text-muted">{SOURCE_LABELS[e.source]}</span>
            <span className="min-w-0 flex-1 truncate">{e.note}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-muted">Les entrées ne se modifient pas : une erreur se corrige par une entrée négative.</p>
    </div>
  );
}
