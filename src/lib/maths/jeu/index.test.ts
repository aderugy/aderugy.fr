import { describe, expect, it } from "../test-kit";
import {
  BAREME,
  evenements,
  joursActifs,
  niveau,
  objectifDuJour,
  recordSerie,
  serie,
  seuilNiveau,
  xpParJour,
  xpTotal,
  type EntreesJeu,
} from "./index";

const VIDE: EntreesJeu = { capsules: [], tentatives: [], revisions: [], sessions: [] };

const tentative = (
  exerciseKey: string,
  difficulty: number,
  outcome: "resolu-seul" | "resolu-avec-indice" | "echec" | "abandonne",
  createdAt: string,
) => ({ exerciseKey, nodeId: exerciseKey.split("/")[0], difficulty, outcome, createdAt });

describe("evenements", () => {
  it("une capsule rapporte, plus un bonus au premier essai du checkpoint", () => {
    const evs = evenements({
      ...VIDE,
      capsules: [
        { nodeId: "n", moduleId: "a", completedAt: "2026-10-20T08:00:00Z", checkpointTries: 1 },
        { nodeId: "n", moduleId: "b", completedAt: "2026-10-20T09:00:00Z", checkpointTries: 3 },
        { nodeId: "n", moduleId: "c", completedAt: "2026-10-20T10:00:00Z", checkpointTries: null },
      ],
    });
    expect(xpTotal(evs)).toBe(3 * BAREME.capsule + BAREME.premierEssai);
  });

  it("un exercice ne rapporte que ses améliorations", () => {
    const evs = evenements({
      ...VIDE,
      tentatives: [
        tentative("n/e1", 2, "echec", "2026-10-20T08:00:00Z"), // 2·2 = 4
        tentative("n/e1", 2, "resolu-avec-indice", "2026-10-20T09:00:00Z"), // 10, +6
        tentative("n/e1", 2, "echec", "2026-10-20T10:00:00Z"), // rien, et rien de retiré
        tentative("n/e1", 2, "resolu-seul", "2026-10-21T10:00:00Z"), // 20, +10
        tentative("n/e1", 2, "resolu-seul", "2026-10-22T10:00:00Z"), // rien
      ],
    });
    expect(evs.map((e) => e.xp)).toEqual([4, 6, 10]);
    expect(xpTotal(evs)).toBe(BAREME.exercice["resolu-seul"] * 2);
  });

  it("l'ordre de saisie ne change rien : on trie par date", () => {
    const evs = evenements({
      ...VIDE,
      tentatives: [
        tentative("n/e1", 1, "resolu-seul", "2026-10-21T08:00:00Z"),
        tentative("n/e1", 1, "echec", "2026-10-20T08:00:00Z"),
      ],
    });
    expect(xpTotal(evs)).toBe(10);
  });

  it("le test de sortie rapporte une fois par nœud", () => {
    const evs = evenements({
      ...VIDE,
      tentatives: [
        tentative("n/e9", 4, "echec", "2026-10-20T08:00:00Z"),
        tentative("n/e9", 4, "resolu-avec-indice", "2026-10-20T09:00:00Z"),
        tentative("n/e11", 5, "resolu-seul", "2026-10-21T09:00:00Z"),
        tentative("m/e4", 4, "resolu-seul", "2026-10-21T09:00:00Z"),
      ],
    });
    expect(evs.filter((e) => e.type === "test-de-sortie").map((e) => e.nodeId)).toEqual(["n", "m"]);
  });

  it("les révisions rapportent par carte distincte du jour", () => {
    const evs = evenements({ ...VIDE, revisions: [{ jour: "2026-10-20", nodeId: "n", cartes: 7 }] });
    expect(xpTotal(evs)).toBe(7);
    expect(evs[0].jour).toBe("2026-10-20");
  });

  it("range un événement tardif au bon jour de Paris", () => {
    // 22 h 30 UTC le 20 octobre = 0 h 30 à Paris le 21.
    const evs = evenements({
      ...VIDE,
      capsules: [{ nodeId: "n", moduleId: "a", completedAt: "2026-10-20T22:30:00Z", checkpointTries: null }],
    });
    expect(evs[0].jour).toBe("2026-10-21");
  });
});

describe("xpParJour", () => {
  it("donne les n derniers jours, zéros compris", () => {
    const evs = evenements({ ...VIDE, revisions: [{ jour: "2026-10-19", nodeId: "n", cartes: 3 }] });
    expect(xpParJour(evs, "2026-10-20", 3)).toEqual([
      { jour: "2026-10-18", xp: 0 },
      { jour: "2026-10-19", xp: 3 },
      { jour: "2026-10-20", xp: 0 },
    ]);
  });
});

describe("niveau", () => {
  it("chaque niveau coûte 100 XP de plus que le précédent", () => {
    expect([1, 2, 3, 4].map(seuilNiveau)).toEqual([0, 100, 300, 600]);
    expect(niveau(0)).toMatchObject({ niveau: 1, depuis: 0, jusqua: 100, part: 0 });
    expect(niveau(99).niveau).toBe(1);
    expect(niveau(100).niveau).toBe(2);
    expect(niveau(450)).toMatchObject({ niveau: 3, depuis: 300, jusqua: 600, part: 0.5 });
  });
});

describe("serie", () => {
  const jours = (...d: string[]) => new Set(d);

  it("compte les jours consécutifs jusqu'à aujourd'hui", () => {
    // 2026-10-20 est un mardi.
    const s = serie(jours("2026-10-18", "2026-10-19", "2026-10-20"), "2026-10-20");
    expect(s).toMatchObject({ longueur: 3, aujourdhui: true, jokers: [] });
  });

  it("tient jusqu'à minuit si aujourd'hui n'est pas encore fait", () => {
    const s = serie(jours("2026-10-18", "2026-10-19"), "2026-10-20");
    expect(s).toMatchObject({ longueur: 2, aujourdhui: false });
  });

  it("un joker par semaine comble un jour manqué", () => {
    // Lundi 19 manqué, couvert par le joker de la semaine du 19.
    const s = serie(jours("2026-10-17", "2026-10-18", "2026-10-20"), "2026-10-20");
    expect(s).toMatchObject({ longueur: 4, jokers: ["2026-10-19"], jokerDisponible: false });
  });

  it("un joker couvre hier tant qu'aujourd'hui peut encore compter", () => {
    const s = serie(jours("2026-10-17", "2026-10-18"), "2026-10-20");
    expect(s).toMatchObject({ longueur: 3, aujourdhui: false, jokers: ["2026-10-19"] });
  });

  it("deux jours manqués d'affilée cassent la série", () => {
    const s = serie(jours("2026-10-16", "2026-10-17", "2026-10-20"), "2026-10-20");
    expect(s.longueur).toBe(1);
  });

  it("deux trous la même semaine : le second casse", () => {
    // Semaine du 12 : trous le 13 et le 15.
    const s = serie(jours("2026-10-12", "2026-10-14", "2026-10-16"), "2026-10-16");
    expect(s.longueur).toBe(3); // 16, 15 (joker), 14 ; le 13 n'a plus de joker
  });

  it("des trous dans deux semaines différentes ont chacun leur joker", () => {
    // Trou le 18 (semaine du 12) et le 20 (semaine du 19).
    const s = serie(jours("2026-10-16", "2026-10-17", "2026-10-19", "2026-10-21"), "2026-10-21");
    expect(s.longueur).toBe(6);
    expect(s.jokers).toEqual(["2026-10-20", "2026-10-18"]);
  });

  it("aucune activité : série nulle", () => {
    expect(serie(jours(), "2026-10-20")).toMatchObject({ longueur: 0, record: 0 });
  });
});

describe("recordSerie", () => {
  it("garde la plus longue série passée", () => {
    const actifs = new Set(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-10"]);
    expect(recordSerie(actifs)).toBe(4);
    expect(serie(actifs, "2026-10-20").record).toBe(4);
  });
});

describe("joursActifs", () => {
  it("réunit capsules, tentatives, révisions et séances", () => {
    const s = joursActifs({
      capsules: [{ nodeId: "n", moduleId: "a", completedAt: "2026-10-18T10:00:00Z", checkpointTries: null }],
      tentatives: [tentative("n/e", 1, "echec", "2026-10-19T10:00:00Z")],
      revisions: [
        { jour: "2026-10-20", nodeId: "n", cartes: 2 },
        { jour: "2026-10-15", nodeId: "n", cartes: 0 },
      ],
      sessions: [{ createdAt: "2026-10-21T10:00:00Z" }],
    });
    expect([...s].sort()).toEqual(["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"]);
  });
});

describe("objectifDuJour", () => {
  it("avancer et entretenir, chacun avec son détail", () => {
    const [avancer, entretenir] = objectifDuJour({
      capsulesAujourdhui: 1,
      tentativesAujourdhui: 2,
      fileRestante: 0,
      cartesAujourdhui: 5,
    });
    expect(avancer).toMatchObject({ fait: true, detail: "1 capsule, 2 exercices" });
    expect(entretenir).toMatchObject({ fait: true, detail: "5 cartes révisées" });
    const [a2, e2] = objectifDuJour({ capsulesAujourdhui: 0, tentativesAujourdhui: 0, fileRestante: 3, cartesAujourdhui: 0 });
    expect(a2.fait).toBe(false);
    expect(e2).toMatchObject({ fait: false, detail: "3 cartes en attente" });
  });
});
