import { describe, expect, it } from "../test-kit";
import {
  computeStates,
  EMPTY_EVIDENCE,
  meriteLearned,
  meriteMastered,
  niveauIntrinseque,
  type Evidence,
  type ExerciseResult,
  type Outcome,
} from "./rules";
import type { Graph, GraphNode, ProgressState } from "../graph/types";

// ── Fabriques ───────────────────────────────────────────────────────────────

function ex(
  difficulty: ExerciseResult["difficulty"],
  outcome: Outcome,
): ExerciseResult {
  return { difficulty, outcome };
}

function evidence(p: Partial<Evidence> = {}): Evidence {
  return { ...EMPTY_EVIDENCE, ...p };
}

/** Graphe minimal : a -> b -> c, plus d qui dépend de a et de c. */
function graphe(): Graph {
  const mk = (id: string, requires: string[]): GraphNode => ({
    id,
    kind: "concept",
    title: id,
    parentId: "t",
    requires,
    estimatedHours: 1,
    tags: [],
    unlocks: [],
    hours: 1,
    contentStatus: "empty",
    coursePath: null,
    ancestors: ["d0", "t"],
  });
  const concepts = [
    mk("a", []),
    mk("b", ["a"]),
    mk("c", ["b"]),
    mk("d", ["a", "c"]),
  ];
  return {
    nodes: concepts,
    byId: new Map(concepts.map((c) => [c.id, c])),
    domains: [],
    concepts,
    order: ["a", "b", "c", "d"],
  };
}

/** Preuves suffisantes pour `learned` : 4 exercices faciles, 4 réussis dont 2 seuls. */
const LEARNED = evidence({
  courseRead: true,
  exercises: [
    ex(1, "resolu-seul"),
    ex(2, "resolu-seul"),
    ex(3, "resolu-avec-indice"),
    ex(2, "resolu-avec-indice"),
  ],
});

const MASTERED = evidence({
  ...LEARNED,
  exercises: [...LEARNED.exercises, ex(4, "resolu-seul")],
  cardStabilities: [30, 45, 22],
});

// ── learned ─────────────────────────────────────────────────────────────────

describe("meriteLearned", () => {
  it("exige que le cours soit lu", () => {
    expect(meriteLearned({ ...LEARNED, courseRead: false })).toBe(false);
  });

  it("refuse un nœud sans exercice de difficulté ≤ 3", () => {
    expect(
      meriteLearned(
        evidence({ courseRead: true, exercises: [ex(4, "resolu-seul")] }),
      ),
    ).toBe(false);
  });

  it("accepte exactement 70 % de réussite", () => {
    // 10 exercices faciles, 7 réussis dont 4 sans indice.
    const exercises = [
      ...Array.from({ length: 4 }, () => ex(2, "resolu-seul" as Outcome)),
      ...Array.from({ length: 3 }, () => ex(2, "resolu-avec-indice" as Outcome)),
      ...Array.from({ length: 3 }, () => ex(2, "echec" as Outcome)),
    ];
    expect(meriteLearned(evidence({ courseRead: true, exercises }))).toBe(true);
  });

  it("refuse 60 % de réussite", () => {
    const exercises = [
      ...Array.from({ length: 6 }, () => ex(2, "resolu-seul" as Outcome)),
      ...Array.from({ length: 4 }, () => ex(2, "echec" as Outcome)),
    ];
    expect(meriteLearned(evidence({ courseRead: true, exercises }))).toBe(false);
  });

  it("refuse quand moins de la moitié des réussites sont sans indice", () => {
    const exercises = [
      ex(1, "resolu-seul"),
      ex(2, "resolu-avec-indice"),
      ex(3, "resolu-avec-indice"),
      ex(2, "resolu-avec-indice"),
    ];
    expect(meriteLearned(evidence({ courseRead: true, exercises }))).toBe(false);
  });

  it("ne compte pas un abandon comme une réussite", () => {
    const exercises = [
      ex(1, "resolu-seul"),
      ex(2, "resolu-seul"),
      ex(3, "abandonne"),
      ex(2, "abandonne"),
    ];
    expect(meriteLearned(evidence({ courseRead: true, exercises }))).toBe(false);
  });
});

// ── mastered ────────────────────────────────────────────────────────────────

describe("meriteMastered", () => {
  it("exige un exercice de difficulté 4 ou 5 réussi", () => {
    expect(meriteMastered({ ...MASTERED, exercises: LEARNED.exercises })).toBe(
      false,
    );
  });

  it("accepte une réussite avec indice sur un exercice difficile", () => {
    expect(
      meriteMastered({
        ...MASTERED,
        exercises: [...LEARNED.exercises, ex(5, "resolu-avec-indice")],
      }),
    ).toBe(true);
  });

  it("refuse un nœud sans aucune carte : pas de preuve de rétention", () => {
    expect(meriteMastered({ ...MASTERED, cardStabilities: [] })).toBe(false);
  });

  it("refuse si une seule carte est sous le seuil de 21 jours", () => {
    expect(meriteMastered({ ...MASTERED, cardStabilities: [30, 21] })).toBe(
      false,
    );
  });

  it("accepte quand toutes les cartes dépassent le seuil", () => {
    expect(meriteMastered(MASTERED)).toBe(true);
  });
});

// ── perte de maîtrise ───────────────────────────────────────────────────────

describe("perte de maîtrise", () => {
  it("un nœud maîtrisé retombe en learned quand la stabilité s'effondre", () => {
    expect(niveauIntrinseque(MASTERED)).toBe("mastered");
    const apresEchec = { ...MASTERED, cardStabilities: [30, 45, 3] };
    expect(niveauIntrinseque(apresEchec)).toBe("learned");
  });

  it("ne retombe pas en dessous de learned : les exercices restent acquis", () => {
    const apresEchec = { ...MASTERED, cardStabilities: [1] };
    expect(niveauIntrinseque(apresEchec)).toBe("learned");
  });
});

// ── marquage manuel ─────────────────────────────────────────────────────────

describe("marquage manuel", () => {
  it("un test de sortie donne learned sans aucun exercice", () => {
    expect(niveauIntrinseque(evidence({ manual: "learned" }))).toBe("learned");
  });

  it("un marquage mastered manuel n'est pas remis en cause par l'absence de cartes", () => {
    expect(niveauIntrinseque(evidence({ manual: "mastered" }))).toBe("mastered");
  });

  it("les preuves surclassent un marquage learned", () => {
    expect(niveauIntrinseque({ ...MASTERED, manual: "learned" })).toBe(
      "mastered",
    );
  });

  it("un cours lu seul donne in-progress", () => {
    expect(niveauIntrinseque(evidence({ courseRead: true }))).toBe(
      "in-progress",
    );
  });
});

// ── propagation dans le DAG ─────────────────────────────────────────────────

describe("computeStates", () => {
  const etats = (ev: Record<string, Evidence>) =>
    computeStates(graphe(), new Map(Object.entries(ev)));

  it("ouvre les racines et verrouille le reste", () => {
    const s = etats({});
    expect(s.get("a")).toBe("available");
    expect(s.get("b")).toBe("locked");
    expect(s.get("d")).toBe("locked");
  });

  it("débloque le successeur direct dès que le prérequis est learned", () => {
    const s = etats({ a: LEARNED });
    expect(s.get("a")).toBe("learned");
    expect(s.get("b")).toBe("available");
    expect(s.get("c")).toBe("locked");
  });

  it("exige tous les prérequis, pas seulement un", () => {
    const s = etats({ a: LEARNED, b: LEARNED });
    expect(s.get("c")).toBe("available");
    expect(s.get("d")).toBe("locked"); // c manque encore
  });

  it("ouvre un nœud à prérequis multiples quand tous sont satisfaits", () => {
    const s = etats({ a: LEARNED, b: LEARNED, c: LEARNED });
    expect(s.get("d")).toBe("available");
  });

  it("mastered vaut learned pour le déblocage", () => {
    const s = etats({ a: MASTERED });
    expect(s.get("b")).toBe("available");
  });

  it("un nœud commencé hors séquence reste in-progress, pas locked", () => {
    const s = etats({ c: evidence({ courseRead: true }) });
    expect(s.get("c")).toBe("in-progress");
    expect(s.get("d")).toBe("locked");
  });

  it("reverrouille en cascade quand un prérequis perd son statut", () => {
    const avant = etats({ a: LEARNED, b: LEARNED, c: LEARNED });
    expect(avant.get("d")).toBe("available");
    // b retombe : c n'a plus ses prérequis, et d perd c.
    const apres = etats({ a: LEARNED, c: evidence({ manual: "none" }) });
    expect(apres.get("b")).toBe("available");
    expect(apres.get("c")).toBe("locked");
    expect(apres.get("d")).toBe("locked");
  });

  it("un prérequis intermédiaire perdu ne reverrouille pas un nœud acquis par lui-même", () => {
    // d ne dépend pas de b : si c reste learned, d reste ouvert.
    const s = etats({ a: LEARNED, c: LEARNED });
    expect(s.get("b")).toBe("available");
    expect(s.get("d")).toBe("available");
  });

  it("couvre tous les concepts du graphe", () => {
    const s = etats({});
    expect([...s.keys()].sort()).toEqual(["a", "b", "c", "d"]);
    for (const v of s.values())
      expect(
        ["locked", "available", "in-progress", "learned", "mastered"],
      ).toContain(v as ProgressState);
  });
});
