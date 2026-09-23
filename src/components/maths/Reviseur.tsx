"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { noterCarte } from "@/server/actions/maths";

export type CarteVue = {
  cardKey: string;
  nodeId: string;
  cardId: string;
  nodeTitle: string;
  ref: string;
  nouvelle: boolean;
  stability: number;
  reps: number;
  lapses: number;
};

const NOTES = [
  { note: 1 as const, touche: "1", libelle: "oublié" },
  { note: 2 as const, touche: "2", libelle: "difficile" },
  { note: 3 as const, touche: "3", libelle: "correct" },
  { note: 4 as const, touche: "4", libelle: "facile" },
];

export default function Reviseur({
  cartes,
  faces,
}: {
  cartes: CarteVue[];
  /** Recto et verso déjà rendus côté serveur (MDX + KaTeX). */
  faces: { front: React.ReactNode; back: React.ReactNode }[];
}) {
  const [i, setI] = useState(0);
  const [montre, setMontre] = useState(false);
  const [notes, setNotes] = useState<number[]>([]);
  const [enCours, startTransition] = useTransition();

  const carte = cartes[i];
  const fini = i >= cartes.length;

  const noter = useCallback(
    (note: number) => {
      if (!carte || enCours) return;
      startTransition(async () => {
        await noterCarte(carte.cardKey, carte.nodeId, carte.cardId, note);
        setNotes((n) => [...n, note]);
        setMontre(false);
        setI((k) => k + 1);
      });
    },
    [carte, enCours],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (fini) return;
      if (!montre && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        setMontre(true);
        return;
      }
      if (montre) {
        const n = NOTES.find((x) => x.touche === e.key);
        if (n) {
          e.preventDefault();
          noter(n.note);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [montre, fini, noter]);

  if (cartes.length === 0) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-8">
        <p className="text-lg font-semibold tracking-tight">Rien à réviser aujourd&apos;hui.</p>
        <p className="chrome text-muted mt-2">
          Les cartes reviennent quand l&apos;ordonnanceur estime que la
          rétention est retombée à 90 %.
        </p>
        <Link href="/maths" className="chrome mt-6 inline-block text-accent hover:underline">
          retour au parcours
        </Link>
      </div>
    );
  }

  if (fini) {
    const compte = (n: number) => notes.filter((x) => x === n).length;
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-8">
        <p className="text-lg font-semibold tracking-tight">
          {notes.length} carte{notes.length > 1 ? "s" : ""} révisée
          {notes.length > 1 ? "s" : ""}.
        </p>
        <table className="chrome mt-4">
          <tbody>
            {NOTES.map((n) => (
              <tr key={n.note} className="border-line border-b">
                <td className="py-1 pr-8">{n.libelle}</td>
                <td className="py-1 text-right tabular-nums">
                  {compte(n.note)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Link href="/maths" className="chrome mt-6 inline-block text-accent hover:underline">
          retour au parcours
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 grow flex-col">
      {/* Règle haute : où l'on en est, et rien d'autre. */}
      <div className="chrome flex h-9 shrink-0 items-center gap-3 overflow-hidden border-b border-line px-4 whitespace-nowrap text-muted">
        <span className="tabular-nums">
          {i + 1} / {cartes.length}
        </span>
        <span>·</span>
        <span>{carte.nodeTitle}</span>
        {carte.nouvelle ? (
          <>
            <span>·</span>
            <span>nouvelle</span>
          </>
        ) : (
          <>
            <span>·</span>
            <span>
              stabilité {carte.stability.toFixed(1)} j · {carte.reps} révision
              {carte.reps > 1 ? "s" : ""}
              {carte.lapses > 0 ? ` · ${carte.lapses} rechute` : ""}
              {carte.lapses > 1 ? "s" : ""}
            </span>
          </>
        )}
        <div className="grow" />
        <Link href="/maths" className="hover:text-foreground">
          quitter
        </Link>
      </div>

      <div className="min-h-0 grow overflow-y-auto px-4 py-8 sm:px-10 sm:py-10">
        <div className="prose-cours">
          {faces[i].front}

          {montre && (
            <>
              <hr className="border-line my-8" />
              {faces[i].back}
              <p className="chrome text-muted mt-8">
                <Link
                  href={`/maths/n/${carte.nodeId}#${carte.ref}`}
                  className="text-accent hover:underline"
                >
                  relire la section « {carte.ref} » du cours
                </Link>
              </p>
            </>
          )}
        </div>
      </div>

      {/* Règle basse : les seules actions possibles. */}
      <div className="chrome flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-t border-line px-4 py-2">
        {!montre ? (
          <button
            onClick={() => setMontre(true)}
            className="rounded bg-accent px-3 py-1 text-white"
          >
            afficher la réponse
            <span className="ml-2 text-white/70">espace</span>
          </button>
        ) : (
          NOTES.map((n) => (
            <button
              key={n.note}
              disabled={enCours}
              onClick={() => noter(n.note)}
              className="rounded border border-line bg-surface hover:border-accent px-3 py-1 disabled:opacity-50"
            >
              {n.libelle}
              <span className="text-muted ml-2">{n.touche}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
