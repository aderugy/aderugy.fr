import { describe, expect, it } from "../test-kit";
import {
  chargeAVenir,
  courbeOubli,
  heuresParDomaine,
  noeudsFragiles,
  RAISONS,
  reussiteParTag,
  type EtatCarteBrut,
  type TentativeBrute,
} from "./index";
import type { Graph, GraphNode, ProgressState } from "../graph/types";
import { EMPTY_EVIDENCE, type Evidence } from "../progression/rules";

const T0 = new Date("2026-09-10T08:00:00.000Z");

function noeud(
  id: string,
  kind: GraphNode["kind"],
  parentId: string | null,
  ancestors: string[],
  tags: string[] = [],
  h = 10,
): GraphNode {
  return {
    id,
    kind,
    title: id,
    parentId,
    requires: [],
    estimatedHours: kind === "concept" ? h : 0,
    tags,
    unlocks: [],
    hours: h,
    contentStatus: "empty",
    coursePath: null,
    ancestors,
  };
}

/** Deux domaines, un topic chacun, deux concepts chacun. */
function graphe(): Graph {
  const n = [
    noeud("d0", "domain", null, []),
    noeud("t0", "topic", "d0", ["d0"]),
    noeud("a", "concept", "t0", ["d0", "t0"], ["analyse"], 10),
    noeud("b", "concept", "t0", ["d0", "t0"], ["analyse", "preuve"], 20),
    noeud("d1", "domain", null, []),
    noeud("t1", "topic", "d1", ["d1"]),
    noeud("c", "concept", "t1", ["d1", "t1"], ["preuve"], 30),
  ];
  const concepts = n.filter((x) => x.kind === "concept");
  return {
    nodes: n,
    byId: new Map(n.map((x) => [x.id, x])),
    domains: n.filter((x) => x.kind === "domain"),
    concepts,
    order: concepts.map((x) => x.id),
  };
}

const carte = (p: Partial<EtatCarteBrut> = {}): EtatCarteBrut => ({
  nodeId: "a",
  stability: 30,
  due: "2026-09-20",
  lastReview: T0.toISOString(),
  lapses: 0,
  ...p,
});

const tentative = (p: Partial<TentativeBrute> = {}): TentativeBrute => ({
  nodeId: "a",
  difficulty: 2,
  outcome: "resolu-seul",
  minutesSpent: 10,
  ...p,
});

// ── Heures par domaine ──────────────────────────────────────────────────────

describe("heuresParDomaine", () => {
  const etats = new Map<string, ProgressState>([
    ["a", "learned"],
    ["b", "in-progress"],
    ["c", "mastered"],
  ]);

  it("sépare heures estimées, heures acquises et temps réel", () => {
    const l = heuresParDomaine(
      graphe(),
      etats,
      new Map([
        ["a", 300],
        ["b", 45],
      ]),
    );
    expect(l[0]).toMatchObject({
      id: "d0",
      heuresEstimees: 30,
      heuresAcquises: 10, // b est seulement en cours
      minutesReelles: 345,
      concepts: 2,
      conceptsAcquis: 1,
    });
    expect(l[1]).toMatchObject({ id: "d1", heuresAcquises: 30, minutesReelles: 0 });
  });

  it("compte mastered comme acquis", () => {
    const l = heuresParDomaine(graphe(), etats, new Map());
    expect(l[1].conceptsAcquis).toBe(1);
  });

  it("renvoie une ligne par domaine, même vide", () => {
    expect(heuresParDomaine(graphe(), new Map(), new Map())).toHaveLength(2);
  });
});

// ── Réussite par tag ────────────────────────────────────────────────────────

describe("reussiteParTag", () => {
  it("attribue une tentative à tous les tags de son nœud", () => {
    const l = reussiteParTag(graphe(), [tentative({ nodeId: "b" })]);
    expect(l.map((x) => x.tag).sort()).toEqual(["analyse", "preuve"]);
    for (const x of l) expect(x.essais).toBe(1);
  });

  it("distingue réussite et réussite sans indice", () => {
    const l = reussiteParTag(graphe(), [
      tentative({ outcome: "resolu-seul" }),
      tentative({ outcome: "resolu-avec-indice" }),
      tentative({ outcome: "echec" }),
    ]);
    const analyse = l.find((x) => x.tag === "analyse")!;
    expect(analyse).toMatchObject({ essais: 3, reussis: 2, sansIndice: 1 });
    expect(analyse.taux).toBeCloseTo(2 / 3, 6);
  });

  it("classe le tag le plus faible en premier", () => {
    const l = reussiteParTag(graphe(), [
      tentative({ nodeId: "a", outcome: "resolu-seul" }), // analyse
      tentative({ nodeId: "c", outcome: "echec" }), // preuve
    ]);
    expect(l[0].tag).toBe("preuve");
  });

  it("n'invente pas de tag sans tentative", () => {
    expect(reussiteParTag(graphe(), [])).toEqual([]);
  });
});

// ── Courbe d'oubli ──────────────────────────────────────────────────────────

describe("courbeOubli", () => {
  it("part de 1 quand la carte vient d'être révisée, puis décroît", () => {
    const c = courbeOubli([carte()], T0, 30);
    expect(c[0].retention).toBeCloseTo(1, 6);
    for (let i = 1; i < c.length; i++) {
      expect(c[i].retention).toBeLessThan(c[i - 1].retention);
    }
  });

  it("vaut la rétention cible au bout de S jours", () => {
    const c = courbeOubli([carte({ stability: 20 })], T0, 20);
    expect(c[20].retention).toBeCloseTo(0.9, 6);
  });

  it("ignore les cartes jamais révisées plutôt que de les compter pour zéro", () => {
    const c = courbeOubli([carte(), carte({ lastReview: null, stability: 0 })], T0, 5);
    expect(c[0].cartes).toBe(1);
    expect(c[0].retention).toBeCloseTo(1, 6);
  });

  it("renvoie une courbe nulle et zéro carte quand rien n'a été révisé", () => {
    const c = courbeOubli([carte({ lastReview: null, stability: 0 })], T0, 3);
    expect(c.every((p) => p.cartes === 0 && p.retention === 0)).toBe(true);
  });

  it("moyenne sur les cartes : une stable et une fragile encadrent la moyenne", () => {
    const stable = carte({ stability: 200 });
    const fragile = carte({ stability: 2 });
    const m = courbeOubli([stable, fragile], T0, 10)[10].retention;
    const seul = (c: EtatCarteBrut) => courbeOubli([c], T0, 10)[10].retention;
    expect(m).toBeGreaterThan(seul(fragile));
    expect(m).toBeLessThan(seul(stable));
  });
});

// ── Charge à venir ──────────────────────────────────────────────────────────

describe("chargeAVenir", () => {
  it("reporte le retard sur le jour 0", () => {
    const c = chargeAVenir(
      [carte({ due: "2026-08-01" }), carte({ due: "2026-09-10" })],
      T0,
      5,
    );
    expect(c[0].cartes).toBe(2);
  });

  it("place chaque carte sur son jour d'échéance", () => {
    const c = chargeAVenir([carte({ due: "2026-09-13" })], T0, 5);
    expect(c[3].cartes).toBe(1);
    expect(c.filter((p) => p.cartes > 0)).toHaveLength(1);
  });

  it("ignore les échéances au-delà de la fenêtre", () => {
    const c = chargeAVenir([carte({ due: "2027-01-01" })], T0, 5);
    expect(c.every((p) => p.cartes === 0)).toBe(true);
  });
});

// ── Nœuds fragiles ──────────────────────────────────────────────────────────

describe("noeudsFragiles", () => {
  const preuves = (p: Partial<Evidence>) =>
    new Map([["a", { ...EMPTY_EVIDENCE, ...p }]]);

  const etats = (e: ProgressState) => new Map<string, ProgressState>([["a", e]]);

  it("ne signale ni les nœuds verrouillés ni les disponibles", () => {
    const cartes = [carte({ lapses: 5 })];
    expect(noeudsFragiles(graphe(), etats("locked"), new Map(), cartes)).toEqual([]);
    expect(noeudsFragiles(graphe(), etats("available"), new Map(), cartes)).toEqual([]);
  });

  it("signale une majorité de réussites avec indice", () => {
    const f = noeudsFragiles(
      graphe(),
      etats("learned"),
      preuves({
        exercises: [
          { difficulty: 2, outcome: "resolu-avec-indice" },
          { difficulty: 2, outcome: "resolu-avec-indice" },
          { difficulty: 2, outcome: "resolu-seul" },
        ],
      }),
      [],
    );
    expect(f[0].raisons).toContain(RAISONS.indices);
  });

  it("ne conclut pas sur une seule réussite", () => {
    const f = noeudsFragiles(
      graphe(),
      etats("learned"),
      preuves({ exercises: [{ difficulty: 2, outcome: "resolu-avec-indice" }] }),
      [],
    );
    expect(f).toEqual([]);
  });

  it("signale une carte qui a rechuté deux fois", () => {
    const f = noeudsFragiles(graphe(), etats("in-progress"), new Map(), [
      carte({ lapses: 2 }),
    ]);
    expect(f[0].raisons).toEqual([RAISONS.rechutes]);
  });

  it("une seule rechute ne suffit pas", () => {
    expect(
      noeudsFragiles(graphe(), etats("in-progress"), new Map(), [
        carte({ lapses: 1 }),
      ]),
    ).toEqual([]);
  });

  it("signale une stabilité sous le seuil sur un nœud acquis", () => {
    const f = noeudsFragiles(graphe(), etats("learned"), new Map(), [
      carte({ stability: 3 }),
    ]);
    expect(f[0].raisons).toContain(RAISONS.stabilite);
  });

  it("ne reproche pas sa stabilité à un nœud seulement en cours", () => {
    expect(
      noeudsFragiles(graphe(), etats("in-progress"), new Map(), [
        carte({ stability: 3 }),
      ]),
    ).toEqual([]);
  });

  it("une carte neuve n'est pas une faiblesse", () => {
    expect(
      noeudsFragiles(graphe(), etats("learned"), new Map(), [
        carte({ stability: 0, lastReview: null }),
      ]),
    ).toEqual([]);
  });

  it("cumule les raisons et classe le plus fragile en tête", () => {
    const etatsDeux = new Map<string, ProgressState>([
      ["a", "learned"],
      ["b", "learned"],
    ]);
    const f = noeudsFragiles(
      graphe(),
      etatsDeux,
      preuves({
        exercises: [
          { difficulty: 2, outcome: "resolu-avec-indice" },
          { difficulty: 2, outcome: "resolu-avec-indice" },
        ],
      }),
      [carte({ lapses: 3, stability: 2 }), carte({ nodeId: "b", lapses: 2 })],
    );
    expect(f[0].nodeId).toBe("a");
    expect(f[0].raisons).toHaveLength(3);
    expect(f[1].nodeId).toBe("b");
  });
});
