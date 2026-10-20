"use client";

import { useState, useTransition } from "react";
import { contenuExercice, enregistrerTentative } from "@/server/actions/maths";

export type TentativeVue = {
  outcome: string;
  minutesSpent: number;
  note: string;
  createdAt: string;
};

type Contenu = Awaited<ReturnType<typeof contenuExercice>>;

const ISSUES = [
  { valeur: "resolu-seul", libelle: "résolu seul" },
  { valeur: "resolu-avec-indice", libelle: "résolu avec indice" },
  { valeur: "echec", libelle: "échec" },
  { valeur: "abandonne", libelle: "abandonné" },
];

/**
 * Un exercice : énoncé toujours visible, indices révélés un par un, correction
 * révélée en dernier. Le formulaire de tentative n'apparaît qu'une fois la
 * correction ouverte — enregistrer une issue avant de l'avoir lue n'a pas de
 * sens, et le champ « ce qui a bloqué » se remplit à ce moment-là.
 *
 * Le contenu n'est demandé au serveur qu'à la première ouverture : la page
 * n'embarque que l'en-tête de chaque exercice.
 */
export default function Exercice({
  numero,
  nodeId,
  exerciseId,
  kind,
  difficulty,
  tentatives,
}: {
  numero: number;
  nodeId: string;
  exerciseId: string;
  kind: string;
  difficulty: number;
  tentatives: TentativeVue[];
}) {
  const [indicesOuverts, setIndicesOuverts] = useState(0);
  const [correction, setCorrection] = useState(false);
  const [ouvert, setOuvert] = useState(false);
  const [contenu, setContenu] = useState<Contenu | null>(null);
  const [erreur, setErreur] = useState(false);
  const [chargement, demarrer] = useTransition();

  function charger() {
    setErreur(false);
    demarrer(async () => {
      try {
        setContenu(await contenuExercice(nodeId, exerciseId));
      } catch {
        setErreur(true);
      }
    });
  }

  function basculer() {
    const ouvrir = !ouvert;
    setOuvert(ouvrir);
    if (ouvrir && !contenu && !chargement) charger();
  }

  const meilleure = tentatives[0];

  return (
    <li className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="chrome flex items-baseline gap-3">
        <span className="text-muted tabular-nums">{numero}</span>
        <span className="font-mono text-[12px]" title={`difficulté ${difficulty}`}>
          {"▮".repeat(difficulty)}
          {"▯".repeat(5 - difficulty)}
        </span>
        <span>{kind}</span>
        <div className="grow" />
        {meilleure && (
          <span className="text-muted">
            {ISSUES.find((i) => i.valeur === meilleure.outcome)?.libelle} ·{" "}
            {meilleure.minutesSpent} min
          </span>
        )}
        <button
          onClick={basculer}
          className="rounded border border-line px-2 hover:border-accent"
          aria-expanded={ouvert}
        >
          {ouvert ? "replier" : "ouvrir"}
        </button>
      </div>

      {ouvert && (
        <div className="mt-3">
          {!contenu ? (
            <p className="chrome text-muted">
              {erreur ? (
                <>
                  chargement impossible ·{" "}
                  <button onClick={charger} className="underline hover:text-foreground">
                    réessayer
                  </button>
                </>
              ) : (
                "chargement…"
              )}
            </p>
          ) : (
            <>
              <div className="prose-cours">{contenu.statement}</div>

              {contenu.hints.slice(0, indicesOuverts).map((h, k) => (
                <div key={k} className="border-line mt-3 border-l pl-4">
                  <div className="chrome text-muted">indice {k + 1}</div>
                  <div className="prose-cours">{h}</div>
                </div>
              ))}

              <div className="chrome mt-4 flex gap-2">
                {indicesOuverts < contenu.hints.length && (
                  <button
                    onClick={() => setIndicesOuverts((n) => n + 1)}
                    className="rounded border border-line bg-surface hover:border-accent px-2 py-1"
                  >
                    indice {indicesOuverts + 1} sur {contenu.hints.length}
                  </button>
                )}
                {!correction && (
                  <button
                    onClick={() => setCorrection(true)}
                    className="rounded border border-line bg-surface hover:border-accent px-2 py-1"
                  >
                    afficher la correction
                  </button>
                )}
              </div>

              {correction && (
                <>
                  <div className="border-line mt-4 border-t pt-4">
                    <div className="chrome text-muted mb-1">correction</div>
                    <div className="prose-cours">{contenu.solution}</div>
                  </div>

                  <form
                    action={enregistrerTentative.bind(
                      null,
                      nodeId,
                      exerciseId,
                      difficulty,
                    )}
                    className="chrome border-line mt-4 flex flex-wrap items-end gap-3 border-t pt-4"
                  >
                    <label className="flex flex-col gap-1">
                      <span className="text-muted">issue</span>
                      <select
                        name="outcome"
                        defaultValue={
                          indicesOuverts > 0 ? "resolu-avec-indice" : "resolu-seul"
                        }
                        className="rounded border border-line bg-surface px-2 py-1 focus:border-accent focus:outline-none"
                      >
                        {ISSUES.map((i) => (
                          <option key={i.valeur} value={i.valeur}>
                            {i.libelle}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-muted">minutes</span>
                      <input
                        name="minutes"
                        type="number"
                        min={0}
                        max={1440}
                        defaultValue={15}
                        className="w-20 rounded border border-line bg-surface px-2 py-1 focus:border-accent focus:outline-none"
                      />
                    </label>
                    <label className="flex grow flex-col gap-1">
                      <span className="text-muted">ce qui a bloqué</span>
                      <input
                        name="note"
                        type="text"
                        className="rounded border border-line bg-surface px-2 py-1 focus:border-accent focus:outline-none"
                      />
                    </label>
                    <button
                      type="submit"
                      className="rounded bg-accent px-3 py-1 text-white"
                    >
                      enregistrer la tentative
                    </button>
                  </form>
                </>
              )}

            </>
          )}

          {tentatives.length > 0 && (
            <ul className="chrome text-muted mt-3">
              {tentatives.map((t, k) => (
                <li key={k} className="py-0.5">
                  {t.createdAt} ·{" "}
                  {ISSUES.find((i) => i.valeur === t.outcome)?.libelle} ·{" "}
                  {t.minutesSpent} min
                  {t.note && ` · ${t.note}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
