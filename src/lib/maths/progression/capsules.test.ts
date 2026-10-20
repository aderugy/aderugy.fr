import { describe, expect, it } from "../test-kit";
import {
  avancementCapsules,
  coursTermine,
  exercicesParCapsule,
  voisine,
} from "./capsules";

const CAPSULES = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("avancementCapsules", () => {
  it("propose la première capsule quand rien n'est lu", () => {
    const av = avancementCapsules(CAPSULES, new Set());
    expect(av.prochaine).toBe("a");
    expect(av.terminees).toBe(0);
    expect(av.total).toBe(3);
    expect(av.etats.get("a")).toBe("prochaine");
    expect(av.etats.get("b")).toBe("a-lire");
  });

  it("propose la première non terminée, même après un saut", () => {
    // On a lu c avant b : la suivante proposée reste b, dans l'ordre du nœud.
    const av = avancementCapsules(CAPSULES, new Set(["a", "c"]));
    expect(av.prochaine).toBe("b");
    expect(av.terminees).toBe(2);
    expect(av.etats.get("c")).toBe("terminee");
  });

  it("ne propose plus rien quand tout est lu", () => {
    const av = avancementCapsules(CAPSULES, new Set(["a", "b", "c"]));
    expect(av.prochaine).toBe(null);
    expect(av.terminees).toBe(3);
  });

  it("ignore les capsules terminées qui n'existent plus", () => {
    // Une capsule renommée laisse une ligne orpheline en base.
    const av = avancementCapsules(CAPSULES, new Set(["ancienne", "a"]));
    expect(av.terminees).toBe(1);
  });
});

describe("coursTermine", () => {
  it("demande toutes les capsules", () => {
    expect(coursTermine(CAPSULES, new Set(["a", "b"]))).toBe(false);
    expect(coursTermine(CAPSULES, new Set(["a", "b", "c"]))).toBe(true);
  });

  it("n'est jamais vrai pour un nœud sans capsule", () => {
    expect(coursTermine([], new Set(["a"]))).toBe(false);
  });
});

describe("voisine", () => {
  it("donne la précédente et la suivante, null aux bouts", () => {
    expect(voisine(CAPSULES, "b", 1)).toBe("c");
    expect(voisine(CAPSULES, "b", -1)).toBe("a");
    expect(voisine(CAPSULES, "c", 1)).toBe(null);
    expect(voisine(CAPSULES, "a", -1)).toBe(null);
    expect(voisine(CAPSULES, "inconnue", 1)).toBe(null);
  });
});

describe("exercicesParCapsule", () => {
  it("range chaque exercice après sa capsule, les autres en fin", () => {
    const ex = [
      { id: "1", after: "a" },
      { id: "2", after: "c" },
      { id: "3", after: "a" },
      { id: "4", after: null },
      { id: "5", after: "faute-de-frappe" },
    ];
    const m = exercicesParCapsule(CAPSULES, ex);
    expect(m.get("a")!.map((e) => e.id)).toEqual(["1", "3"]);
    expect(m.get("c")!.map((e) => e.id)).toEqual(["2"]);
    expect(m.get(null)!.map((e) => e.id)).toEqual(["4", "5"]);
    expect(m.has("b")).toBe(false);
  });
});
