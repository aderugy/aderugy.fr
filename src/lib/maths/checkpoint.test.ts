import { describe, expect, it } from "./test-kit";
import { corriger, estJuste, lireNombre, ordreChoix, versFichier } from "./checkpoint";
import { lireCheckpoint, type Question } from "./content";

const QCM: Question = { type: "qcm", question: "q", choix: ["a", "b", "c"], reponse: 2, explication: "e" };
const VF: Question = { type: "vrai-faux", question: "q", reponse: false, explication: "e" };
const NB: Question = { type: "nombre", question: "q", reponse: 101, tolerance: 0, explication: "e" };

describe("lireNombre", () => {
  it("accepte la virgule, les espaces et la notation scientifique", () => {
    expect(lireNombre("0,5")).toBe(0.5);
    expect(lireNombre(" 1 000 001 ")).toBe(1000001);
    expect(lireNombre("1e-3")).toBe(0.001);
    expect(lireNombre("-2")).toBe(-2);
  });
  it("refuse ce qui n'est pas un nombre", () => {
    expect(lireNombre("")).toBe(null);
    expect(lireNombre("1/2")).toBe(null);
    expect(lireNombre("abc")).toBe(null);
  });
});

describe("estJuste", () => {
  it("qcm : l'indice exact seulement", () => {
    expect(estJuste(QCM, 2)).toBe(true);
    expect(estJuste(QCM, 1)).toBe(false);
    expect(estJuste(QCM, "2")).toBe(false);
    expect(estJuste(QCM, null)).toBe(false);
  });
  it("vrai-faux : le booléen, pas une chaîne", () => {
    expect(estJuste(VF, false)).toBe(true);
    expect(estJuste(VF, true)).toBe(false);
    expect(estJuste(VF, "false")).toBe(false);
  });
  it("nombre : exact par défaut, avec tolérance sinon", () => {
    expect(estJuste(NB, "101")).toBe(true);
    expect(estJuste(NB, 100)).toBe(false);
    expect(estJuste({ ...NB, reponse: 1.414, tolerance: 0.001 }, "1,4142")).toBe(true);
    expect(estJuste({ ...NB, reponse: 0.3 }, 0.1 + 0.2)).toBe(true);
  });
});

describe("corriger", () => {
  it("tout est juste seulement si chaque réponse l'est", () => {
    expect(corriger([QCM, VF, NB], [2, false, "101"])).toEqual({ justes: [true, true, true], tout: true });
    expect(corriger([QCM, VF, NB], [2, true, "101"]).tout).toBe(false);
    expect(corriger([QCM, VF], [2])).toEqual({ justes: [true, false], tout: false });
  });
  it("un checkpoint vide est réussi d'office", () => {
    expect(corriger([], []).tout).toBe(true);
  });
});

describe("lireCheckpoint", () => {
  it("lit les trois types", () => {
    const qs = lireCheckpoint(
      [
        { type: "qcm", question: "q", choix: ["a", "b"], reponse: 1, explication: "e" },
        { type: "vrai-faux", question: "q", reponse: true, explication: "e" },
        { type: "nombre", question: "q", reponse: "3", explication: "e" },
      ],
      "test",
    );
    expect(qs.map((q) => q.type)).toEqual(["qcm", "vrai-faux", "nombre"]);
    expect((qs[2] as { tolerance: number }).tolerance).toBe(0);
  });
  it("lève sur une question mal formée", () => {
    const leve = (brut: unknown) => {
      try {
        lireCheckpoint(brut, "test");
        return false;
      } catch {
        return true;
      }
    };
    expect(leve([{ type: "qcm", question: "q", choix: ["a", "b"], reponse: 2, explication: "e" }])).toBe(true);
    expect(leve([{ type: "vrai-faux", question: "q", reponse: "oui", explication: "e" }])).toBe(true);
    expect(leve([{ type: "qcm", question: "q", choix: ["a", "b"], reponse: 0 }])).toBe(true);
    expect(leve([{ type: "ordre", question: "q", explication: "e" }])).toBe(true);
    expect(leve("pas une liste")).toBe(true);
    expect(leve(undefined)).toBe(false);
  });
});


describe("ordreChoix", () => {
  it("est une permutation, toujours la même pour une graine", () => {
    const o = ordreChoix(4, "n/m/0");
    expect([...o].sort()).toEqual([0, 1, 2, 3]);
    expect(ordreChoix(4, "n/m/0")).toEqual(o);
  });
  it("déplace la bonne réponse d'une question à l'autre", () => {
    // Sur 30 questions dont la bonne réponse est rédigée en position 1, elle
    // ne doit pas s'afficher toujours au même endroit.
    const positions = new Set(
      Array.from({ length: 30 }, (_, i) => ordreChoix(4, `n/m/${i}`).indexOf(1)),
    );
    expect(positions.size).toBeGreaterThan(2);
  });
});

describe("versFichier", () => {
  it("ramène la position affichée d'un qcm à l'indice du fichier", () => {
    const q = { type: "qcm" as const, question: "q", choix: ["a", "b", "c"], reponse: 1, explication: "e" };
    const ordre = ordreChoix(3, "g");
    const affiche = ordre.indexOf(1);
    const [r] = versFichier([q], [affiche], () => "g");
    expect(r).toBe(1);
    expect(corriger([q], [r]).tout).toBe(true);
  });
  it("rejette les réponses de mauvaise forme", () => {
    const qs = [
      { type: "qcm" as const, question: "q", choix: ["a", "b"], reponse: 0, explication: "e" },
      { type: "vrai-faux" as const, question: "q", reponse: true, explication: "e" },
    ];
    expect(versFichier(qs, ["0", "true"], () => "g")).toEqual([null, null]);
    expect(versFichier(qs, [7, true], () => "g")).toEqual([null, true]);
  });
});
