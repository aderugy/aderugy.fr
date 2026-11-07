"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { pct } from "@/lib/projects/clock";
import { fmtWhenFr } from "@/lib/projects/format";
import { LIMITS, PROJECT_STATUS_LABELS, type ProjectStatus } from "@/lib/projects/types";
import type { ProjectState } from "@/server/projects/data";
import { removeProject, setProjectStatus, updateProject } from "@/server/actions/projects";
import { ConfirmButton, Section, btn, btnPrimary, input, useAction } from "./bits";

/**
 * The contract (R21): question, deliverable, deadline, 2–4 learning
 * objectives, what may be delegated, stopping rules. Claude drafts it; only
 * Arthur validates it, and once validated the objectives are his alone.
 */
export function ContractTab({
  state,
  categories,
}: {
  state: ProjectState;
  categories: { id: string; path: string }[];
}) {
  const p = state.project;
  const router = useRouter();
  const [name, setName] = useState(p.name);
  const [question, setQuestion] = useState(p.question ?? "");
  const [deliverable, setDeliverable] = useState(p.deliverable ?? "");
  const [deadline, setDeadline] = useState(p.deadline ?? "");
  const [objectives, setObjectives] = useState<string[]>(() => {
    const o = [...p.objectives];
    while (o.length < LIMITS.objectives) o.push("");
    return o;
  });
  const [delegated, setDelegated] = useState(p.delegated_md ?? "");
  const [stopping, setStopping] = useState(p.stopping_rules_md ?? "");
  const [repo, setRepo] = useState(p.repo_url ?? "");
  const [category, setCategory] = useState(p.category_id ?? "");
  const { pending, error, run } = useAction();
  const [saved, setSaved] = useState(false);

  const filled = objectives.filter((o) => o.trim()).length;
  const fields = {
    name,
    question,
    deliverable,
    deadline: deadline || null,
    objectives,
    delegated_md: delegated,
    stopping_rules_md: stopping,
    repo_url: repo,
    category_id: category || null,
  };
  const save = () => run(() => updateProject(p.id, fields), () => setSaved(true));
  const status = (s: ProjectStatus) => run(() => setProjectStatus(p.id, s));
  const st = state.stats;

  return (
    <div className="mt-4 space-y-3">
      {p.status === "draft" && (
        <section className="rounded-lg border border-accent bg-accent/5 p-4 text-sm">
          <p className="font-medium">Brouillon{p.validated_at ? "" : " — pas encore validé"}</p>
          <p className="mt-1 text-muted">
            Relis chaque champ (Claude a pu le rédiger), puis valide : les étapes pourront s&apos;ouvrir, et les objectifs
            ne seront plus modifiables que par toi.
          </p>
          {filled < 2 && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">Le protocole demande 2 à 4 objectifs d&apos;apprentissage.</p>}
          <button
            type="button"
            disabled={pending || !question.trim() || filled === 0}
            onClick={() => run(async () => {
              const r = await updateProject(p.id, fields);
              if (!r.ok) return r;
              return setProjectStatus(p.id, "active");
            })}
            className={`mt-3 ${btnPrimary}`}
          >
            Valider le contrat
          </button>
        </section>
      )}

      <Section title="Contrat">
        <div className="space-y-3">
          <Field label="Nom">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.name} className={input} />
          </Field>
          <Field label="Question">
            <textarea value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={LIMITS.question} rows={2} className={input} />
          </Field>
          <Field label="Livrable">
            <textarea value={deliverable} onChange={(e) => setDeliverable(e.target.value)} maxLength={LIMITS.deliverable} rows={2} className={input} />
          </Field>
          <Field label="Échéance">
            <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} className={input} />
          </Field>
          <Field label={`Objectifs d'apprentissage (le cœur)${p.validated_at ? " — figés pour Claude" : ""}`}>
            <div className="space-y-1.5">
              {objectives.map((o, n) => (
                <div key={n} className="flex items-center gap-2">
                  <span className="w-4 shrink-0 text-xs text-muted">{n + 1}.</span>
                  <input
                    value={o}
                    onChange={(e) => setObjectives(objectives.map((x, i) => (i === n ? e.target.value : x)))}
                    maxLength={LIMITS.objective}
                    className={input}
                  />
                </div>
              ))}
            </div>
          </Field>
          <Field label="Ce qui peut être délégué (Markdown)">
            <textarea value={delegated} onChange={(e) => setDelegated(e.target.value)} maxLength={LIMITS.longText} rows={4} className={input} />
          </Field>
          <Field label="Règles d'arrêt (Markdown)">
            <textarea value={stopping} onChange={(e) => setStopping(e.target.value)} maxLength={LIMITS.longText} rows={4} className={input} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Dépôt">
              <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/…" className={input} />
            </Field>
            <Field label="Catégorie de l'agenda">
              <select value={category} onChange={(e) => setCategory(e.target.value)} className={input}>
                <option value="">—</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.path}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="flex items-center gap-3">
            {saved && !pending && <span className="text-xs text-muted">Enregistré.</span>}
            <button type="button" disabled={pending} onClick={save} className={`ml-auto ${btn}`}>
              Enregistrer
            </button>
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      </Section>

      <Section title="Statistiques">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Stat label="Dépassement médian" value={st.medianRatio === null ? "—" : `× ${st.medianRatio.toFixed(2)}`} />
          <Stat label="Fermées par la coupe" value={`${pct(st.shareCut)} (${st.closedSteps} fermées)`} />
          <Stat label="Garés par jour (14 j)" value={String(st.parkedPerDay)} />
          <Stat label="… dont soulevés par Claude" value={pct(st.parkedByClaude)} />
        </dl>
        <div className="mt-3">
          <div className="text-xs text-muted">Étapes fermées par semaine</div>
          <div className="mt-1 flex items-end gap-2">
            {st.stepsPerWeek.map((w) => (
              <div key={w.week} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex h-12 w-full items-end">
                  <div className="w-full rounded-t bg-accent/60" style={{ height: `${Math.min(100, w.count * 25)}%`, minHeight: w.count ? 4 : 0 }} />
                </div>
                <span className="text-[10px] tabular-nums text-muted">
                  {w.week.slice(8)}/{w.week.slice(5, 7)} · {w.count}
                </span>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section title="Projet">
        <p className="text-sm">
          Statut : <span className="font-medium">{PROJECT_STATUS_LABELS[p.status]}</span>
          {p.validated_at && <span className="text-muted"> · contrat validé {fmtWhenFr(p.validated_at)}</span>}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {p.status === "active" && (
            <button type="button" disabled={pending} onClick={() => status("paused")} className={btn}>
              Mettre en pause
            </button>
          )}
          {p.status === "paused" && (
            <button type="button" disabled={pending} onClick={() => status("active")} className={btn}>
              Reprendre
            </button>
          )}
          {(p.status === "active" || p.status === "paused") && (
            <button type="button" disabled={pending} onClick={() => status("done")} className={btn}>
              Terminer
            </button>
          )}
          {p.status === "done" && (
            <button type="button" disabled={pending} onClick={() => status("active")} className={btn}>
              Réactiver
            </button>
          )}
          {p.status !== "draft" && (
            <button type="button" disabled={pending} onClick={() => status("draft")} className={btn}>
              Repasser en brouillon
            </button>
          )}
        </div>
        <div className="mt-4 border-t border-line pt-3">
          <ConfirmButton
            label="Supprimer le projet"
            confirmLabel={`Supprimer ${p.slug}, ses étapes, son temps et ses messages`}
            disabled={pending}
            onConfirm={() => run(() => removeProject(p.id), () => router.push("/projects"))}
          />
        </div>
      </Section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs text-muted">
      {label}
      <div className="mt-1 text-sm text-foreground">{children}</div>
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
