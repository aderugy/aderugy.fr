import "server-only";
import { loadCards, cardKey, type Card } from "@/lib/maths/content";
import type { Graph, GraphNode } from "@/lib/maths/graph/types";
import { marquagesManuels, type DonneesMaths } from "@/server/maths/data";
import {
  EMPTY_EVIDENCE,
  type Evidence,
  type ExerciseResult,
  type Outcome,
} from "./rules";

/** Du meilleur au pire. Sert à ne garder qu'une tentative par exercice. */
const RANG: Outcome[] = [
  "abandonne",
  "echec",
  "resolu-avec-indice",
  "resolu-seul",
];

let cacheCartes: Map<string, Card[]> | null = null;

/** Cartes de tous les concepts, indexées par nœud. */
export function cartesParNoeud(graph: Graph): Map<string, Card[]> {
  if (cacheCartes && process.env.NODE_ENV === "production") return cacheCartes;
  const m = new Map<string, Card[]>();
  for (const c of graph.concepts) {
    const cards = loadCards(c);
    if (cards.length > 0) m.set(c.id, cards);
  }
  cacheCartes = m;
  return m;
}

/**
 * Assemble les preuves de chaque nœud à partir du contenu et de la base.
 *
 * Un point mérite attention : les stabilités FSRS sont calculées sur **toutes**
 * les cartes définies dans cards.yaml, pas seulement sur celles déjà révisées.
 * Une carte jamais vue compte pour une stabilité nulle. Sans cela, un nœud dont
 * une seule carte sur onze aurait été révisée passerait `mastered`, ce que la
 * règle du §4 n'autorise évidemment pas.
 */
export function evidenceParNoeud(
  graph: Graph,
  donnees: DonneesMaths,
): Map<string, Evidence> {
  const manuels = marquagesManuels(donnees);
  const etats = donnees.reviewStates;
  const cartes = cartesParNoeud(graph);

  // Meilleure tentative par exercice.
  const meilleures = new Map<string, { nodeId: string } & ExerciseResult>();
  for (const a of donnees.attempts) {
    const courant = meilleures.get(a.exerciseKey);
    const mieux =
      !courant || RANG.indexOf(a.outcome) > RANG.indexOf(courant.outcome);
    if (mieux) {
      meilleures.set(a.exerciseKey, {
        nodeId: a.nodeId,
        difficulty: a.difficulty as ExerciseResult["difficulty"],
        outcome: a.outcome,
      });
    }
  }

  const exercicesParNoeud = new Map<string, ExerciseResult[]>();
  for (const e of meilleures.values()) {
    const liste = exercicesParNoeud.get(e.nodeId) ?? [];
    liste.push({ difficulty: e.difficulty, outcome: e.outcome });
    exercicesParNoeud.set(e.nodeId, liste);
  }

  const out = new Map<string, Evidence>();
  for (const node of graph.concepts) {
    const manuel = manuels.get(node.id);
    const exercises = exercicesParNoeud.get(node.id) ?? [];
    const cardStabilities = (cartes.get(node.id) ?? []).map(
      (c) => etats.get(cardKey(node.id, c.id))?.stability ?? 0,
    );
    if (
      !manuel &&
      exercises.length === 0 &&
      cardStabilities.every((s) => s === 0)
    ) {
      continue; // rien à dire sur ce nœud
    }
    out.set(node.id, {
      ...EMPTY_EVIDENCE,
      courseRead: manuel?.courseRead ?? false,
      manual: manuel?.manual ?? "none",
      exercises,
      cardStabilities,
    });
  }
  return out;
}

/** Preuves d'un seul nœud, pour la page de nœud. */
export function evidenceDuNoeud(
  graph: Graph,
  donnees: DonneesMaths,
  node: GraphNode,
): Evidence {
  return evidenceParNoeud(graph, donnees).get(node.id) ?? EMPTY_EVIDENCE;
}
