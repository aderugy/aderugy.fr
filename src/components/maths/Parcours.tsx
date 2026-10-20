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
  boss,
  bossVaincu,
  numeros,
  tentatives,
}: {
  nodeId: string;
  capsules: Capsule[];
  avancement: Avancement;
  /** Exercices ordinaires, rangés après leur capsule. */
  exercicesApres: Map<string | null, ExerciseFile[]>;
  /** Exercices difficiles : le test de sortie, en fin de parcours. */
  boss: ExerciseFile[];
  bossVaincu: boolean;
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
                    {etat === "terminee"
                      ? exos.length === 1
                        ? "exercice faisable à ce stade"
                        : `${exos.length} exercices faisables à ce stade`
                      : exos.length === 1
                        ? "exercice faisable une fois la capsule lue"
                        : `${exos.length} exercices faisables une fois la capsule lue`}
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

      {boss.length > 0 && (
        <div id="test-de-sortie" className="border-line mt-8 scroll-mt-24 border-t pt-4">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h2 className="text-lg font-semibold tracking-tight">Test de sortie</h2>
            <span className="chrome text-muted">
              {bossVaincu ? "✓ réussi" : "à réussir pour la maîtrise"}
            </span>
          </div>
          <p className="chrome text-muted mt-1 mb-3 max-w-[70ch]">
            Les exercices les plus difficiles du nœud. En réussir un, seul ou
            avec indice, remplit la condition « exercice difficile » de la
            maîtrise ; c&apos;est aussi le test qui permet de valider le nœud
            sans le parcourir.
          </p>
          <ListeExercices
            nodeId={nodeId}
            exercices={boss}
            numeros={numeros}
            tentatives={tentatives}
          />
        </div>
      )}

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
