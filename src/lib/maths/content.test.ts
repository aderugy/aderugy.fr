import { describe, expect, it } from "./test-kit";
import {
  composerCours,
  lienSource,
  lireNomCapsule,
  loadCards,
  loadCourse,
  loadCourseShell,
  loadExercises,
  loadModules,
  RUBRIQUE,
  type Capsule,
} from "./content";
import { loadGraph } from "./graph/load";

const capsule = (id: string, numero: number, body = "texte"): Capsule => ({
  id,
  numero,
  title: `Titre ${id}`,
  minutes: 5,
  rubrique: [],
  checkpoint: [],
  body,
});

describe("lireNomCapsule", () => {
  it("sépare le numéro d'ordre de l'id stable", () => {
    expect(lireNomCapsule("03-definition-convergence.mdx")).toEqual({
      numero: 3,
      id: "definition-convergence",
    });
  });

  it("refuse un nom sans numéro ou mal formé", () => {
    expect(lireNomCapsule("definition.mdx")).toBe(null);
    expect(lireNomCapsule("3-definition.mdx")).toBe(null);
    expect(lireNomCapsule("03-Definition.mdx")).toBe(null);
    expect(lireNomCapsule("03-definition.md")).toBe(null);
  });
});

describe("composerCours", () => {
  const coquille = { data: { status: "published" }, body: "## Liens {#liens}\n\nx\n" };

  it("met chaque capsule sous un titre ancré sur son id, puis la coquille", () => {
    const c = composerCours(coquille, [capsule("a", 1, "corps a"), capsule("b", 2, "corps b")])!;
    expect(c.data).toEqual({ status: "published" });
    const titres = c.body.split("\n").filter((l) => l.startsWith("## "));
    expect(titres).toEqual(["## Titre a {#a}", "## Titre b {#b}", "## Liens {#liens}"]);
    expect(c.body.indexOf("corps a") < c.body.indexOf("corps b")).toBe(true);
  });

  it("laisse un cours non découpé tel quel", () => {
    expect(composerCours(coquille, [])).toBe(coquille);
  });

  it("n'invente pas de cours sans coquille", () => {
    // Le statut vit dans le frontmatter de course.mdx (D2) : sans lui, le
    // nœud est vide, même si des capsules traînent sur le disque.
    expect(composerCours(null, [capsule("a", 1)])).toBe(null);
  });
});

describe("lienSource", () => {
  const caps = [{ id: "borne-sup" }];
  it("renvoie vers la capsule quand l'ancre en est une", () => {
    expect(lienSource("n", "borne-sup", caps)).toBe("/maths/n/n/m/borne-sup");
  });
  it("renvoie vers la section du nœud sinon", () => {
    expect(lienSource("n", "liens", caps)).toBe("/maths/n/n#liens");
    expect(lienSource("n", "", caps)).toBe("/maths/n/n");
  });
});

// ── Le contenu réel ─────────────────────────────────────────────────────────
//
// Garde-fou sur les nœuds découpés : une capsule renommée ne doit laisser ni
// carte ni exercice pointer dans le vide, et le découpage ne doit rien retirer
// de la rubrique du §6.

describe("nœuds découpés en capsules", () => {
  const graph = loadGraph();
  const decoupes = graph.concepts
    .map((node) => ({ node, capsules: loadModules(node) }))
    .filter((x) => x.capsules.length > 0);

  it("suites-reelles est découpé", () => {
    expect(decoupes.map((x) => x.node.id)).toContain("suites-reelles");
  });

  for (const { node, capsules } of decoupes) {
    const ids = new Set(capsules.map((c) => c.id));
    const coquille = loadCourseShell(node);

    it(`${node.id} : coquille avec statut, liens et références`, () => {
      expect(coquille === null).toBe(false);
      expect(typeof coquille!.data.status).toBe("string");
      expect(coquille!.body.includes("{#liens}")).toBe(true);
      expect(coquille!.body.includes("{#references}")).toBe(true);
    });

    it(`${node.id} : capsules de 5 à 10 minutes, titrées, sans h2`, () => {
      for (const c of capsules) {
        expect(c.title === c.id).toBe(false);
        expect(c.minutes).toBeGreaterThanOrEqual(5);
        expect(c.minutes).toBeLessThanOrEqual(10);
        // Le niveau 2 est réservé au titre de capsule dans le cours composé.
        expect(/^## /m.test(c.body)).toBe(false);
      }
    });

    it(`${node.id} : chaque capsule a un checkpoint de 2 à 4 questions`, () => {
      for (const c of capsules) {
        if (c.checkpoint.length < 2 || c.checkpoint.length > 4)
          throw new Error(`capsule ${c.id} : ${c.checkpoint.length} question(s) au checkpoint`);
      }
    });

    it(`${node.id} : les capsules couvrent les sections 1 à 7 de la rubrique`, () => {
      const couvertes = new Set(capsules.flatMap((c) => c.rubrique));
      const valides = new Set<string>(RUBRIQUE.map((r) => r.id));
      for (const c of capsules) for (const r of c.rubrique) expect(valides.has(r)).toBe(true);
      for (const r of RUBRIQUE.slice(0, 7)) expect(couvertes.has(r.id)).toBe(true);
    });

    it(`${node.id} : chaque carte pointe vers une capsule ou une section du nœud`, () => {
      for (const card of loadCards(node)) {
        const ok = ids.has(card.ref) || card.ref === "liens" || card.ref === "references";
        if (!ok) throw new Error(`carte ${card.id} : ref inconnue ${card.ref}`);
      }
    });

    it(`${node.id} : chaque exercice suit une capsule existante`, () => {
      for (const e of loadExercises(node)) {
        if (!e.after || !ids.has(e.after))
          throw new Error(`exercice ${e.id} : after ${e.after} ne désigne aucune capsule`);
      }
    });

    it(`${node.id} : le cours composé garde une section par capsule`, () => {
      const cours = loadCourse(node)!;
      for (const c of capsules) expect(cours.body.includes(`{#${c.id}}`)).toBe(true);
    });
  }
});
