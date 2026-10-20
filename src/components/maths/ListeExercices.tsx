import { exerciseKey, type ExerciseFile } from "@/lib/maths/content";
import { dateCourte } from "@/lib/maths/etat";
import type { AttemptRow } from "@/server/maths/data";
import Exercice from "@/components/maths/Exercice";

/**
 * Une liste d'exercices d'un nœud. Le numéro affiché est celui du fichier dans
 * le nœud, pas la position dans la liste : quand les exercices sont répartis
 * entre les capsules, « l'exercice 4 » reste l'exercice 4 partout.
 */
export default function ListeExercices({
  nodeId,
  exercices,
  numeros,
  tentatives,
}: {
  nodeId: string;
  exercices: ExerciseFile[];
  numeros: Map<string, number>;
  tentatives: AttemptRow[];
}) {
  return (
    <ul className="space-y-2">
      {exercices.map((e) => {
        const key = exerciseKey(nodeId, e.id);
        return (
          <Exercice
            key={e.id}
            numero={numeros.get(e.id) ?? 0}
            nodeId={nodeId}
            exerciseId={e.id}
            kind={e.kind}
            difficulty={e.difficulty}
            tentatives={tentatives
              .filter((t) => t.exerciseKey === key)
              .map((t) => ({
                outcome: t.outcome,
                minutesSpent: t.minutesSpent,
                note: t.note,
                createdAt: dateCourte(t.createdAt),
              }))}
          />
        );
      })}
    </ul>
  );
}
