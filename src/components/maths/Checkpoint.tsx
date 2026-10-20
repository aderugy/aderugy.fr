"use client";

import { useState, useTransition, type ReactNode } from "react";
import { corrigerCheckpoint, validerCapsule } from "@/server/actions/maths";

export type QuestionVue = {
  type: "qcm" | "vrai-faux" | "nombre";
  /** Énoncé rendu côté serveur (MDX + KaTeX). */
  question: ReactNode;
  /** Choix d'un qcm, déjà dans l'ordre d'affichage. */
  choix: ReactNode[];
};

type Valeur = number | boolean | string | null;

/**
 * Le checkpoint de fin de capsule (décision D26). La correction se fait sur
 * le serveur : ce composant ne connaît pas les bonnes réponses. Une question
 * juste se fige et montre son explication ; une question fausse reste
 * modifiable, sans indice sur la bonne réponse. Quand tout est juste, la
 * capsule peut se terminer.
 *
 * Pour une capsule déjà lue, c'est un entraînement : rien n'est enregistré.
 */
export default function Checkpoint({
  nodeId,
  moduleId,
  questions,
  lue,
  libelleTerminer,
}: {
  nodeId: string;
  moduleId: string;
  questions: QuestionVue[];
  lue: boolean;
  libelleTerminer: string;
}) {
  const [reponses, setReponses] = useState<Valeur[]>(() => questions.map(() => null));
  const [justes, setJustes] = useState<(boolean | null)[]>(() => questions.map(() => null));
  const [explications, setExplications] = useState<(ReactNode | null)[]>(() =>
    questions.map(() => null),
  );
  const [essais, setEssais] = useState(0);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, demarrer] = useTransition();

  const tout = justes.every((j) => j === true);
  const complet = reponses.every((r) => r !== null && r !== "");

  const changer = (i: number, v: Valeur) => {
    if (justes[i]) return;
    setReponses((rs) => rs.map((r, k) => (k === i ? v : r)));
    setJustes((js) => js.map((j, k) => (k === i ? null : j)));
  };

  const verifier = () => {
    setErreur(null);
    demarrer(async () => {
      try {
        const res = await corrigerCheckpoint(nodeId, moduleId, reponses);
        setEssais((n) => n + 1);
        setJustes(res.justes);
        setExplications(res.explications);
      } catch {
        setErreur("correction impossible, réessayer");
      }
    });
  };

  const terminer = () => {
    setErreur(null);
    demarrer(async () => {
      try {
        await validerCapsule(nodeId, moduleId, reponses, essais);
      } catch (e) {
        // La redirection de Next passe par une exception : ne pas l'avaler.
        if (e && typeof e === "object" && "digest" in e) throw e;
        setErreur("enregistrement impossible, réessayer");
      }
    });
  };

  return (
    <section className="mt-12" aria-labelledby="checkpoint">
      <h2 id="checkpoint" className="border-line border-b pb-1 text-lg font-semibold tracking-tight">
        Checkpoint
      </h2>
      <p className="chrome text-muted mt-2">
        {lue
          ? "Capsule déjà lue : entraînement libre, rien n'est enregistré."
          : `${questions.length} questions à réussir pour terminer la capsule. Une réponse fausse ne dévoile pas la bonne.`}
      </p>

      <ol className="mt-4 space-y-6">
        {questions.map((q, i) => {
          const juste = justes[i];
          const nom = `q${i}`;
          return (
            <li key={i} className="border-line border-l pl-4">
              <div className="chrome text-muted flex gap-3">
                <span>question {i + 1}</span>
                {juste === true && <span className="text-foreground">✓ juste</span>}
                {juste === false && <span className="text-foreground">✗ pas encore</span>}
              </div>
              <div className="prose-cours">{q.question}</div>

              <fieldset disabled={juste === true || enCours} className="chrome-15 mt-2">
                <legend className="sr-only">réponse à la question {i + 1}</legend>
                {q.type === "qcm" && (
                  <div className="flex flex-col gap-1.5">
                    {q.choix.map((c, d) => (
                      <label key={d} className="flex cursor-pointer items-baseline gap-2">
                        <input
                          type="radio"
                          name={nom}
                          checked={reponses[i] === d}
                          onChange={() => changer(i, d)}
                          className="accent-current translate-y-0.5"
                        />
                        <span className="prose-cours min-w-0 [&_p]:my-0">{c}</span>
                      </label>
                    ))}
                  </div>
                )}
                {q.type === "vrai-faux" && (
                  <div className="flex gap-6">
                    {[true, false].map((v) => (
                      <label key={String(v)} className="flex cursor-pointer items-center gap-2">
                        <input
                          type="radio"
                          name={nom}
                          checked={reponses[i] === v}
                          onChange={() => changer(i, v)}
                          className="accent-current"
                        />
                        {v ? "vrai" : "faux"}
                      </label>
                    ))}
                  </div>
                )}
                {q.type === "nombre" && (
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    aria-label={`réponse à la question ${i + 1}`}
                    value={typeof reponses[i] === "string" ? (reponses[i] as string) : ""}
                    onChange={(e) => changer(i, e.target.value)}
                    className="w-40 rounded border border-line bg-surface px-2 py-1 tabular-nums focus:border-accent focus:outline-none"
                  />
                )}
              </fieldset>

              {juste === true && explications[i] && (
                <div className="prose-cours text-muted mt-2">{explications[i]}</div>
              )}
            </li>
          );
        })}
      </ol>

      <div className="chrome mt-6 flex flex-wrap items-center gap-3">
        {!tout && (
          <button
            type="button"
            onClick={verifier}
            disabled={!complet || enCours}
            className="rounded border border-line bg-surface px-3 py-1 hover:border-accent disabled:opacity-50"
          >
            {enCours ? "correction…" : "vérifier"}
          </button>
        )}
        {!tout && !complet && <span className="text-muted">répondre à toutes les questions</span>}
        {tout && !lue && (
          <button
            type="button"
            onClick={terminer}
            disabled={enCours}
            className="rounded bg-accent px-3 py-1 text-white disabled:opacity-50"
          >
            {libelleTerminer}
          </button>
        )}
        {tout && (
          <span className="text-muted">
            {essais === 1 ? "réussi du premier coup" : `réussi en ${essais} essais`}
          </span>
        )}
        {erreur && <span role="alert">{erreur}</span>}
      </div>
    </section>
  );
}
