"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Base du CDN Pyodide. **C'est le seul endroit à modifier** pour changer de
 * version ; le worker la reçoit en paramètre. jsDelivr conserve les anciennes
 * versions indéfiniment, donc épingler une version connue est sans risque —
 * en revanche une version inexistante donne un 404 muet, c'est pourquoi
 * l'erreur affichée ci-dessous cite l'URL complète.
 *
 * Surchargeable sans toucher au code par NEXT_PUBLIC_PYODIDE_BASE.
 */
const PYODIDE_BASE =
  process.env.NEXT_PUBLIC_PYODIDE_BASE ??
  "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";

type Etat = "repos" | "chargement" | "calcul" | "fini";

export default function BlocPython({ code }: { code: string }) {
  const [etat, setEtat] = useState<Etat>("repos");
  const [sortie, setSortie] = useState<string | null>(null);
  const [ok, setOk] = useState(true);
  const [ms, setMs] = useState<number | null>(null);
  const worker = useRef<Worker | null>(null);

  useEffect(() => () => worker.current?.terminate(), []);

  function executer() {
    setSortie(null);
    setEtat("calcul");
    if (!worker.current) {
      worker.current = new Worker("/maths/pyodide-worker.js");
      worker.current.onmessage = (e: MessageEvent) => {
        if (e.data.etat === "chargement") return setEtat("chargement");
        setEtat("fini");
        setOk(e.data.ok);
        setSortie(e.data.sortie || "(aucune sortie)");
        setMs(e.data.ms ?? null);
      };
      worker.current.onerror = () => {
        setEtat("fini");
        setOk(false);
        setSortie(
          `Pyodide n'a pas pu être chargé depuis ${PYODIDE_BASE}pyodide.js\n` +
            `Vérifier la connexion réseau, ou la version dans ` +
            `src/components/maths/BlocPython.tsx.`,
        );
      };
    }
    worker.current.postMessage({ code, base: PYODIDE_BASE });
  }

  const libelle =
    etat === "chargement"
      ? "chargement de Python…"
      : etat === "calcul"
        ? "exécution…"
        : "exécuter";

  return (
    <div className="my-5 overflow-hidden rounded-lg border border-line bg-surface">
      <pre className="brut overflow-x-auto p-4 font-mono text-[14px] leading-6">
        <code>{code}</code>
      </pre>
      <div className="chrome border-line flex items-center gap-3 border-t px-3 py-1.5">
        <button
          onClick={executer}
          disabled={etat === "chargement" || etat === "calcul"}
          className="rounded border border-line bg-surface hover:border-accent px-2 py-0.5 disabled:opacity-50"
        >
          {libelle}
        </button>
        {etat === "chargement" && (
          <span className="text-muted">
            premier lancement : Pyodide et NumPy, une dizaine de mégaoctets
          </span>
        )}
        {ms !== null && etat === "fini" && (
          <span className="text-muted tabular-nums">{ms} ms</span>
        )}
      </div>
      {sortie !== null && (
        <pre
          className="brut overflow-x-auto border-t border-line p-4 font-mono text-[13px] leading-5"
          style={ok ? undefined : { color: "var(--maths-alerte)" }}
        >
          {sortie}
        </pre>
      )}
    </div>
  );
}
