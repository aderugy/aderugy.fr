import { describe, expect, it } from "../test-kit";
import { badges, type EntreesBadges } from "./badges";

const VIDE: EntreesBadges = {
  capsules: [],
  tentatives: [],
  revisions: [],
  sessions: [],
  noeudsLus: 0,
  noeudsMaitrises: 0,
  recordSerie: 0,
};

const par = (bs: ReturnType<typeof badges>) => new Map(bs.map((b) => [b.id, b]));

describe("badges", () => {
  it("aucun badge sans activité, avancement à zéro", () => {
    const b = par(badges(VIDE));
    expect([...b.values()].some((x) => x.obtenu)).toBe(false);
    expect(b.get("sans-faute")!.progres).toEqual({ fait: 0, but: 5 });
  });

  it("date un badge au jour où le seuil est atteint", () => {
    const capsules = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"].map(
      (j, i) => ({ nodeId: "n", moduleId: `c${i}`, completedAt: `${j}T10:00:00Z`, checkpointTries: 1 }),
    );
    const b = par(badges({ ...VIDE, capsules }));
    expect(b.get("premiere-capsule")).toMatchObject({ obtenu: true, jour: "2026-10-01" });
    expect(b.get("sans-faute")).toMatchObject({ obtenu: true, jour: "2026-10-05", progres: { fait: 5, but: 5 } });
  });

  it("test de sortie et main sûre ne comptent que les exercices difficiles", () => {
    const t = (k: string, d: number, outcome: "resolu-seul" | "resolu-avec-indice" | "echec", j: string) => ({
      exerciseKey: k,
      nodeId: k.split("/")[0],
      difficulty: d,
      outcome,
      createdAt: `${j}T10:00:00Z`,
    });
    const b = par(
      badges({
        ...VIDE,
        tentatives: [
          t("n/e1", 3, "resolu-seul", "2026-10-01"),
          t("n/e9", 4, "echec", "2026-10-02"),
          t("n/e9", 4, "resolu-avec-indice", "2026-10-03"),
          t("n/e9", 4, "resolu-seul", "2026-10-04"),
          t("n/e9", 4, "resolu-seul", "2026-10-05"),
        ],
      }),
    );
    expect(b.get("test-de-sortie")).toMatchObject({ obtenu: true, jour: "2026-10-03" });
    expect(b.get("main-sure")!.progres).toEqual({ fait: 1, but: 10 });
  });

  it("cent cartes, daté au jour de la centième", () => {
    const b = par(
      badges({
        ...VIDE,
        revisions: [
          { jour: "2026-10-01", nodeId: "n", cartes: 60 },
          { jour: "2026-10-02", nodeId: "m", cartes: 30 },
          { jour: "2026-10-03", nodeId: "n", cartes: 15 },
        ],
      }),
    );
    expect(b.get("cent-cartes")).toMatchObject({ obtenu: true, jour: "2026-10-03" });
  });

  it("séries et maîtrise viennent des agrégats, sans date", () => {
    const b = par(badges({ ...VIDE, recordSerie: 9, noeudsMaitrises: 1, noeudsLus: 2 }));
    expect(b.get("serie-7")).toMatchObject({ obtenu: true, jour: null });
    expect(b.get("serie-30")).toMatchObject({ obtenu: false, progres: { fait: 9, but: 30 } });
    expect(b.get("premiere-maitrise")!.obtenu).toBe(true);
    expect(b.get("noeud-lu")!.obtenu).toBe(true);
  });
});
