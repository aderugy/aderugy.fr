import Link from "next/link";
import { RUBRIQUE, type Capsule, type ExerciseFile } from "@/lib/maths/content";
import type { Avancement } from "@/lib/maths/progression/capsules";
import type { AttemptRow } from "@/server/maths/data";
import ListeExercices from "@/components/maths/ListeExercices";

const LIBELLE_RUBRIQUE = new Map<string, string>(
  RUBRIQUE.map((r) => [r.id, r.label]),
);

/** Glyphes d'avancement, comme les difficultés : ▮ lu, ▯ à lire. */
export function jauge(terminees: number, total: number): string {
  return "▮".repeat(terminees) + "▯".repeat(Math.max(0, total - terminees));
}

/**
 * Le parcours d'un nœud découpé en capsules (décision D25) : les capsules dans
 * l'ordre, chacune suivie des exercices qu'elle rend faisables. Des filets,
 * pas des cartes ; aucune couleur — terminer une capsule n'est pas un niveau
 * de maîtrise, la rampe reste réservée à l'état du nœud.
 */
export default function Parcours({
  nodeId,
  capsules,
  avancement,
  exercicesApres,
  numeros,
  tentatives,
}: {
  nodeId: string;
  capsules: Capsule[];
  avancement: Avancement;
  exercicesApres: Map<string | null, ExerciseFile[]>;
  numeros: Map<string, number>;
  tentatives: AttemptRow[];
}) {
  const orphelins = exercicesApres.get(null) ?? [];
  return (
    <section className="mt-8 max-w-[92ch]">
      <ol className="border-line border-t">
        {capsules.map((c) => {
          const etat = avancement.etats.get(c.id);
          const exos = exercicesApres.get(c.id) ?? [];
          return (
            // L'id porte l'ancre de la capsule : un lien #<id> vers la page du
            // nœud tombe sur sa ligne du parcours.
            <li key={c.id} id={c.id} className="border-line scroll-mt-24 border-b py-3">
              <div className="flex items-baseline gap-3">
                <span className="chrome text-muted w-6 shrink-0 text-right tabular-nums">
                  {c.numero}
                </span>
                <div className="min-w-0 grow">
                  <Link
                    href={`/maths/n/${nodeId}/m/${c.id}`}
                    className={
                      "hover:text-accent " +
                      (etat === "terminee" ? "text-muted" : "font-medium")
                    }
                  >
                    {c.title}
                  </Link>
                  <div className="chrome text-muted flex flex-wrap gap-x-3">
                    <span>{c.minutes} min</span>
                    <span>
                      {c.rubrique
                        .map((r) => LIBELLE_RUBRIQUE.get(r) ?? r)
                        .join(", ")}
                    </span>
                  </div>
                </div>
                <span className="chrome shrink-0">
                  {etat === "terminee" ? (
                    <span className="text-muted">✓ lue</span>
                  ) : etat === "prochaine" ? (
                    // L'action principale est au-dessus du parcours ; ici, un
                    // simple repère, pour ne pas doubler le bouton.
                    <span>à suivre</span>
                  ) : null}
                </span>
              </div>

              {exos.length > 0 && (
                <div className="mt-3 sm:pl-9">
                  <div className="chrome text-muted mb-1.5">
                    {exos.length === 1
                      ? "exercice faisable après cette capsule"
                      : `${exos.length} exercices faisables après cette capsule`}
                  </div>
                  <ListeExercices
                    nodeId={nodeId}
                    exercices={exos}
                    numeros={numeros}
                    tentatives={tentatives}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {orphelins.length > 0 && (
        <div className="mt-6">
          <div className="chrome text-muted mb-1.5">
            exercices sans capsule de rattachement
          </div>
          <ListeExercices
            nodeId={nodeId}
            exercices={orphelins}
            numeros={numeros}
            tentatives={tentatives}
          />
        </div>
      )}
    </section>
  );
}
