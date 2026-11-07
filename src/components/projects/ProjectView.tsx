"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { clockOf, fmtMinutes, overrunRatio, parseMinutes } from "@/lib/projects/clock";
import {
  PARKING_TARGET,
  PROJECT_STATUS_LABELS,
  groupByMilestone,
  isUnreadFor,
  type Item,
  type StepWithSpent,
} from "@/lib/projects/types";
import type { ProjectState } from "@/server/projects/data";
import { logWork, saveItem, setNextAction } from "@/server/actions/projects";
import { OriginBadge, Section, StepPill, TriageChip, btn, btnPrimary, input, sortItems, useAction } from "./bits";
import { stateTone } from "./tone";
import { CloseStepSheet } from "./CloseStepSheet";
import { StepSheet } from "./StepSheet";
import { ParkingReview } from "./ParkingReview";
import { Messages } from "./Messages";
import { ContractTab } from "./ContractTab";

type SheetState =
  | { kind: "step"; stepId: string | null }
  | { kind: "close" }
  | { kind: "review" }
  | null;

export function ProjectView({
  state,
  categories,
  initialTab,
}: {
  state: ProjectState;
  categories: { id: string; path: string }[];
  initialTab: "focus" | "contrat";
}) {
  const [tab, setTab] = useState(initialTab);
  const [sheet, setSheet] = useState<SheetState>(null);
  const { project, steps, open, items } = state;
  const unreadFromClaude = state.messages.filter((m) => isUnreadFor(m, "arthur")).length;

  const setTabUrl = (t: "focus" | "contrat") => {
    setTab(t);
    const url = new URL(window.location.href);
    if (t === "contrat") url.searchParams.set("tab", "contrat");
    else url.searchParams.delete("tab");
    window.history.replaceState(null, "", url);
  };

  return (
    <main className="mx-auto w-full max-w-2xl px-3 py-4 sm:px-6 sm:py-8">
      <div className="flex items-baseline gap-2 px-1">
        <Link href="/projects" className="text-xs text-muted hover:text-foreground">
          Projets /
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">
          <span className="font-mono">{project.slug}</span>
          <span className="font-normal text-muted"> · {project.name}</span>
        </h1>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
            project.status === "active" ? "bg-accent/15 text-accent" : "bg-line text-muted"
          }`}
        >
          {PROJECT_STATUS_LABELS[project.status]}
        </span>
      </div>

      <div className="mt-3 flex gap-1 border-b border-line px-1 text-sm">
        {(["focus", "contrat"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTabUrl(t)}
            className={`-mb-px border-b-2 px-3 py-1.5 ${tab === t ? "border-accent font-medium" : "border-transparent text-muted"}`}
          >
            {t === "focus" ? "Focus" : "Contrat"}
          </button>
        ))}
      </div>

      {tab === "contrat" ? (
        <ContractTab state={state} categories={categories} />
      ) : (
        <div className="mt-4 space-y-3">
          <FocusCard
            state={state}
            unread={unreadFromClaude}
            onClose={() => setSheet({ kind: "close" })}
            onContract={() => setTabUrl("contrat")}
            onStep={(id) => setSheet({ kind: "step", stepId: id })}
          />
          {open && <Todos projectId={project.id} step={open} items={items.filter((i) => i.step_id === open.id)} />}
          <Roadmap steps={steps} onStep={(id) => setSheet({ kind: "step", stepId: id })} />
          <Parking
            projectId={project.id}
            items={items.filter((i) => i.kind === "park" && i.status === "open")}
            steps={steps}
            openStepId={open?.id ?? null}
            onReview={() => setSheet({ kind: "review" })}
          />
          <Messages state={state} />
        </div>
      )}

      {sheet?.kind === "close" && open && (
        <CloseStepSheet state={state} step={open} onClose={() => setSheet(null)} />
      )}
      {sheet?.kind === "step" && (
        <StepSheet
          key={sheet.stepId ?? "new"}
          state={state}
          step={sheet.stepId ? (steps.find((s) => s.id === sheet.stepId) ?? null) : null}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === "review" && <ParkingReview state={state} onClose={() => setSheet(null)} />}
    </main>
  );
}

/* ------------------------------------------------------------ focus card */

function ClockBar({ spent, budget, cut }: { spent: number; budget: number; cut: number }) {
  const c = clockOf(spent, budget, cut);
  const scale = Math.max(cut, spent) * 1.08;
  const at = (m: number) => `${Math.min(100, (Math.max(0, m) / scale) * 100)}%`;
  const tone = stateTone(c.state);
  return (
    <div>
      <div className="relative h-3 rounded-full bg-line/70">
        <div className={`absolute inset-y-0 left-0 rounded-full ${tone.bar}`} style={{ width: at(spent) }} />
        <div className="absolute -inset-y-1 w-px bg-foreground/60" style={{ left: at(budget) }} title="budget" />
        <div className="absolute -inset-y-1 w-0.5 bg-red-500/80" style={{ left: at(cut) }} title="cut line" />
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-muted">
        <span className="absolute -translate-x-1/2" style={{ left: at(budget) }}>
          budget
        </span>
        <span className="absolute -translate-x-1/2" style={{ left: at(cut) }}>
          cut
        </span>
      </div>
    </div>
  );
}

function FocusCard({
  state,
  unread,
  onClose,
  onContract,
  onStep,
}: {
  state: ProjectState;
  unread: number;
  onClose: () => void;
  onContract: () => void;
  onStep: (id: string) => void;
}) {
  const { project, open, steps } = state;
  const { pending, error, run } = useAction();
  const [custom, setCustom] = useState<string | null>(null);

  if (project.status === "draft") {
    return (
      <section className="rounded-lg border border-dashed border-accent bg-surface p-4">
        <h2 className="text-sm font-medium">Contrat en brouillon</h2>
        <p className="mt-1 text-sm text-muted">
          Aucune étape ne s&apos;ouvre avant la validation du contrat : question, livrable, objectifs, délégation, règles
          d&apos;arrêt.
        </p>
        <button type="button" onClick={onContract} className={`mt-3 ${btnPrimary}`}>
          Relire et valider le contrat
        </button>
      </section>
    );
  }

  const next = steps.find((s) => s.status === "todo");
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      {open ? (
        <OpenStep
          step={open}
          onStep={() => onStep(open.id)}
          pending={pending}
          onLog={(m) => run(() => logWork(open.id, m))}
          custom={custom}
          setCustom={setCustom}
          onClose={onClose}
        />
      ) : (
        <div>
          <div className="text-xs font-medium tracking-wide text-muted uppercase">Focus</div>
          <p className="mt-1 text-sm">Aucune étape ouverte.</p>
          {next && project.status === "active" && (
            <button type="button" onClick={() => onStep(next.id)} className={`mt-2 ${btn}`}>
              Ouvrir {next.code} {next.title}…
            </button>
          )}
        </div>
      )}

      <NextAction state={state} />

      <div className="mt-3 flex items-center justify-end">
        <a href="#messages" className={`text-xs ${unread ? "font-semibold text-accent" : "text-muted"}`}>
          ✉ Claude{unread ? ` (${unread})` : ""}
        </a>
      </div>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </section>
  );
}

function OpenStep({
  step,
  onStep,
  pending,
  onLog,
  custom,
  setCustom,
  onClose,
}: {
  step: StepWithSpent;
  onStep: () => void;
  pending: boolean;
  onLog: (minutes: number) => void;
  custom: string | null;
  setCustom: (v: string | null) => void;
  onClose: () => void;
}) {
  const c = clockOf(step.totals.spent, step.budget_minutes, step.cut_minutes);
  const tone = stateTone(c.state);
  const customMinutes = custom === null ? null : parseMinutes(custom);
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium tracking-wide text-muted uppercase">Focus</span>
        <button type="button" onClick={onStep} className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:text-accent">
          {step.code} {step.title}
        </button>
      </div>
      {step.good_enough && <p className="mt-1 text-xs text-muted">Assez bien : {step.good_enough}</p>}

      <div className="mt-3">
        <ClockBar spent={c.spent} budget={c.budget} cut={c.cut} />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium tabular-nums">
          ⏱ {fmtMinutes(c.spent)} / {fmtMinutes(c.budget)}
        </span>
        <span className="text-muted">· cut {fmtMinutes(c.cut)}</span>
        <span className={`ml-auto text-xs font-medium ${tone.text}`}>
          {tone.label}
          {c.state === "over" || c.state === "drift" ? ` +${c.overrunPct} %` : ""}
          {c.state === "ok" ? ` · ${fmtMinutes(c.leftBudget)} restantes` : ""}
        </span>
      </div>
      {c.state === "closing" && (
        <p className="mt-2 rounded bg-red-500/10 px-2 py-1 text-xs text-red-600 dark:text-red-400">
          Ligne de coupe atteinte : seulement des actions de clôture, puis fermer l&apos;étape (coupée, version minimale).
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" disabled={pending} onClick={() => onLog(15)} className={btn}>
          +15
        </button>
        <button type="button" disabled={pending} onClick={() => onLog(30)} className={btn}>
          +30
        </button>
        {custom === null ? (
          <button type="button" onClick={() => setCustom("")} className={btn}>
            +…
          </button>
        ) : (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (customMinutes) {
                onLog(customMinutes);
                setCustom(null);
              }
            }}
          >
            <input
              autoFocus
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setCustom(null)}
              placeholder="1h10, -15"
              className="w-24 rounded border border-line bg-background px-2 py-1 text-sm"
            />
            <button disabled={!customMinutes || pending} className={btn}>
              OK
            </button>
          </form>
        )}
        <button type="button" onClick={onClose} className={`ml-auto ${c.state === "closing" ? btnPrimary : btn}`}>
          Fermer l&apos;étape
        </button>
      </div>
    </div>
  );
}

function NextAction({ state }: { state: ProjectState }) {
  const p = state.project;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(p.next_action ?? "");
  const [minutes, setMinutes] = useState(p.next_action_minutes ? String(p.next_action_minutes) : "");
  const { pending, error, run } = useAction();

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setText(p.next_action ?? "");
          setMinutes(p.next_action_minutes ? String(p.next_action_minutes) : "");
          setEditing(true);
        }}
        className="mt-3 block w-full rounded bg-background px-2 py-1.5 text-left text-sm hover:text-accent"
      >
        <span className="text-xs text-muted">Prochaine action : </span>
        {p.next_action ? (
          <>
            {p.next_action}
            {p.next_action_minutes ? <span className="text-muted"> ≈ {fmtMinutes(p.next_action_minutes)}</span> : null}
            {p.next_action_by === "claude" && <span className="ml-1 text-[10px] text-accent">(Claude)</span>}
          </>
        ) : (
          <span className="text-muted">—</span>
        )}
      </button>
    );
  }
  const m = minutes ? parseMinutes(minutes) : null;
  return (
    <form
      className="mt-3 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => setNextAction(p.id, text, m), () => setEditing(false));
      }}
    >
      <input autoFocus value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="Prochaine action" className={input} />
      <div className="flex items-center gap-2">
        <input value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="≈ 40" className="w-24 rounded border border-line bg-background px-2 py-1 text-sm" />
        <span className="text-xs text-muted">min</span>
        <button type="button" onClick={() => setEditing(false)} className="ml-auto text-xs text-muted underline">
          annuler
        </button>
        <button disabled={pending || (!!minutes && m === null)} className={btn}>
          Enregistrer
        </button>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </form>
  );
}

/* ----------------------------------------------------------------- todos */

function Todos({ projectId, step, items }: { projectId: string; step: StepWithSpent; items: Item[] }) {
  const { pending, error, run } = useAction();
  const [title, setTitle] = useState("");
  const [showDone, setShowDone] = useState(false);
  const sorted = sortItems(items);
  const openOnes = sorted.filter((i) => i.status === "open");
  const closed = sorted.filter((i) => i.status !== "open");

  return (
    <Section title={`À faire dans ${step.code}`}>
      <ul className="divide-y divide-line">
        {[...openOnes, ...(showDone ? closed : [])].map((i) => (
          <li key={i.id} className="flex items-center gap-2 py-1.5">
            <input
              type="checkbox"
              checked={i.status === "done"}
              disabled={pending || i.status === "dropped"}
              onChange={(e) => run(() => saveItem(projectId, { id: i.id, status: e.target.checked ? "done" : "open" }))}
              className="h-4 w-4 shrink-0 accent-[var(--accent)]"
              aria-label="fait"
            />
            <TriageChip triage={i.triage} disabled={pending} onChange={(t) => run(() => saveItem(projectId, { id: i.id, triage: t }))} />
            <span className={`min-w-0 flex-1 text-sm ${i.status !== "open" ? "text-muted line-through" : ""}`}>{i.title}</span>
            {i.origin === "claude" && <OriginBadge origin="claude" />}
            {i.status === "open" && (
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => saveItem(projectId, { id: i.id, step_id: null, blocks_step_id: step.id }))}
                className="shrink-0 text-xs text-muted hover:text-foreground"
                title="Garer (bloque cette étape)"
              >
                garer
              </button>
            )}
          </li>
        ))}
        {openOnes.length === 0 && <li className="py-1.5 text-sm text-muted">Rien d&apos;ouvert.</li>}
      </ul>
      {closed.length > 0 && (
        <button type="button" onClick={() => setShowDone(!showDone)} className="mt-1 text-xs text-muted underline">
          {showDone ? "masquer" : `${closed.length} fait${closed.length > 1 ? "s" : ""}`}
        </button>
      )}
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          run(() => saveItem(projectId, { title, step_id: step.id }), () => setTitle(""));
        }}
      >
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ajouter une tâche" maxLength={300} className={input} />
        <button disabled={pending || !title.trim()} className={btn}>
          +
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </Section>
  );
}

/* --------------------------------------------------------------- roadmap */

function Roadmap({ steps, onStep }: { steps: StepWithSpent[]; onStep: (id: string | null) => void }) {
  const groups = useMemo(() => groupByMilestone(steps), [steps]);
  return (
    <Section
      title="Feuille de route"
      aside={
        <button type="button" onClick={() => onStep(null)} className="text-xs text-muted hover:text-foreground">
          + étape
        </button>
      }
    >
      {groups.length === 0 && <p className="text-sm text-muted">Pas encore d&apos;étapes. Ajoute-les ici ou demande à Claude d&apos;importer le plan.</p>}
      <div className="space-y-2">
        {groups.map((g) => (
          <div key={g.milestone ?? "—"} className="flex gap-2">
            <div className="w-16 shrink-0 truncate pt-0.5 text-xs text-muted" title={g.milestone ?? ""}>
              {g.milestone ?? "—"}
            </div>
            <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
              {g.steps.map((s) => (
                <StepPill
                  key={s.id}
                  code={s.code}
                  status={s.status}
                  ratio={s.status === "done" || s.status === "cut" ? overrunRatio(s.totals.spent, s.budget_minutes) : null}
                  onClick={() => onStep(s.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* --------------------------------------------------------------- parking */

function Parking({
  projectId,
  items,
  steps,
  openStepId,
  onReview,
}: {
  projectId: string;
  items: Item[];
  steps: StepWithSpent[];
  openStepId: string | null;
  onReview: () => void;
}) {
  const { pending, error, run } = useAction();
  const [title, setTitle] = useState("");
  const code = (id: string | null) => (id ? (steps.find((s) => s.id === id)?.code ?? "?") : "—");
  const over = items.length > PARKING_TARGET;
  const sorted = [...items].sort((a, b) => (a.blocks_step_id === openStepId ? -1 : 0) - (b.blocks_step_id === openStepId ? -1 : 0));

  return (
    <Section
      title="Parking"
      aside={
        <div className="flex items-center gap-3">
          <span className={`text-xs tabular-nums ${over ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted"}`}>
            {items.length} / {PARKING_TARGET}
          </span>
          {items.length > 0 && (
            <button type="button" onClick={onReview} className="text-xs text-accent hover:underline">
              Revue
            </button>
          )}
        </div>
      }
    >
      <ul className="divide-y divide-line">
        {sorted.map((i) => (
          <li key={i.id} className="flex items-center gap-2 py-1.5">
            <OriginBadge origin={i.origin} />
            <TriageChip triage={i.triage} disabled={pending} onChange={(t) => run(() => saveItem(projectId, { id: i.id, triage: t }))} />
            <span className="min-w-0 flex-1 text-sm">{i.title}</span>
            <span className={`shrink-0 font-mono text-xs ${i.blocks_step_id && i.blocks_step_id === openStepId ? "text-amber-600 dark:text-amber-400" : "text-muted"}`}>
              → {code(i.blocks_step_id)}
            </span>
          </li>
        ))}
        {items.length === 0 && <li className="py-1.5 text-sm text-muted">Vide.</li>}
      </ul>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          run(() => saveItem(projectId, { title, step_id: null }), () => setTitle(""));
        }}
      >
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Garer une idée (une ligne)" maxLength={300} className={input} />
        <button disabled={pending || !title.trim()} className={btn}>
          +
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </Section>
  );
}
