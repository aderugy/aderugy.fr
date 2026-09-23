import type { Graph, ProgressState } from "@/lib/maths/graph/types";

export type Outcome =
  | "resolu-seul"
  | "resolu-avec-indice"
  | "echec"
  | "abandonne";

export type ExerciseResult = {
  difficulty: 1 | 2 | 3 | 4 | 5;
  /** Meilleure tentative connue pour cet exercice. */
  outcome: Outcome;
};

export type Evidence = {
  courseRead: boolean;
  exercises: ExerciseResult[];
  /** Stabilité FSRS, en jours, de chaque carte du nœud. */
  cardStabilities: number[];
  /**
   * Marquage manuel : test de sortie réussi sans parcourir le nœud (§2), ou
   * relevé à la main tant que le suivi des tentatives n'existe pas (V0).
   */
  manual: "none" | "in-progress" | "learned" | "mastered";
};

export const EMPTY_EVIDENCE: Evidence = {
  courseRead: false,
  exercises: [],
  cardStabilities: [],
  manual: "none",
};

/** Seuils du §4 du prompt. Regroupés ici pour qu'ils soient lisibles d'un coup. */
export const SEUILS = {
  /** Part des exercices de difficulté ≤ 3 à réussir pour `learned`. */
  reussiteFaible: 0.7,
  /** Part des réussites qui doivent être obtenues sans indice. */
  sansIndice: 0.5,
  /** Difficulté minimale d'un exercice « difficile » pour `mastered`. */
  difficulteHaute: 4,
  /** Stabilité FSRS minimale, en jours, de chaque carte pour `mastered`. */
  stabiliteJours: 21,
} as const;

const REUSSI: Outcome[] = ["resolu-seul", "resolu-avec-indice"];

const isReussi = (r: ExerciseResult) => REUSSI.includes(r.outcome);

/**
 * Niveau intrinsèque d'un nœud, indépendamment de ses prérequis : ce que les
 * preuves accumulées justifient. Recalculé à chaque lecture, donc la maîtrise
 * se perd d'elle-même quand les révisions retombent sous le seuil.
 */
export function niveauIntrinseque(
  ev: Evidence,
): "none" | "in-progress" | "learned" | "mastered" {
  if (ev.manual === "mastered") return "mastered";

  const merite = meriteLearned(ev);
  const learned = merite || ev.manual === "learned";

  if (learned && meriteMastered(ev)) return "mastered";
  if (learned) return "learned";
  if (ev.manual === "in-progress" || ev.courseRead || ev.exercises.length > 0)
    return "in-progress";
  return "none";
}

/**
 * `learned` : cours lu, au moins 70 % des exercices de difficulté ≤ 3 réussis,
 * et au moins la moitié de ces réussites obtenues sans indice.
 */
export function meriteLearned(ev: Evidence): boolean {
  if (!ev.courseRead) return false;
  const faciles = ev.exercises.filter((e) => e.difficulty <= 3);
  if (faciles.length === 0) return false;

  const reussis = faciles.filter(isReussi);
  if (reussis.length / faciles.length < SEUILS.reussiteFaible) return false;

  const seuls = reussis.filter((e) => e.outcome === "resolu-seul");
  return seuls.length / reussis.length >= SEUILS.sansIndice;
}

/**
 * `mastered` : au moins un exercice de difficulté 4-5 réussi, et toutes les
 * cartes du nœud au-dessus du seuil de stabilité. Un nœud sans carte ne peut
 * pas être maîtrisé — il n'y a alors aucune preuve de rétention.
 */
export function meriteMastered(ev: Evidence): boolean {
  const dur = ev.exercises.some(
    (e) => e.difficulty >= SEUILS.difficulteHaute && isReussi(e),
  );
  if (!dur) return false;
  if (ev.cardStabilities.length === 0) return false;
  return ev.cardStabilities.every((s) => s > SEUILS.stabiliteJours);
}

/**
 * État de tous les concepts du graphe. Parcourt le DAG dans l'ordre
 * topologique : `available` demande que chaque prérequis soit au moins
 * `learned`, ce qui est donc déjà connu quand on arrive au nœud.
 */
export function computeStates(
  graph: Graph,
  evidence: Map<string, Evidence>,
): Map<string, ProgressState> {
  const states = new Map<string, ProgressState>();

  for (const id of graph.order) {
    const node = graph.byId.get(id)!;
    const ev = evidence.get(id) ?? EMPTY_EVIDENCE;
    const niveau = niveauIntrinseque(ev);

    if (niveau === "mastered" || niveau === "learned") {
      states.set(id, niveau);
      continue;
    }

    const prerequisOk = node.requires.every((r) => {
      const s = states.get(r);
      return s === "learned" || s === "mastered";
    });

    if (niveau === "in-progress") states.set(id, "in-progress");
    else states.set(id, prerequisOk ? "available" : "locked");
  }

  return states;
}

/**
 * État affiché d'un conteneur : le plus avancé de ses descendants, ce qui donne
 * « disponible » dès qu'un concept l'est, conformément à la décision D5.
 */
export function stateOfContainer(
  graph: Graph,
  id: string,
  states: Map<string, ProgressState>,
): ProgressState {
  const rang: ProgressState[] = [
    "locked",
    "available",
    "in-progress",
    "learned",
    "mastered",
  ];
  let best = 0;
  for (const c of graph.concepts) {
    if (c.id !== id && !c.ancestors.includes(id)) continue;
    best = Math.max(best, rang.indexOf(states.get(c.id) ?? "locked"));
  }
  return rang[best];
}
