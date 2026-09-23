import { describe, expect, it } from "../test-kit";
import {
  carteNeuve,
  D_MAX,
  D_MIN,
  difficulteInitiale,
  estDue,
  intervalle,
  joursEcoules,
  premiereRevision,
  RETENTION_CIBLE,
  retrievabilite,
  reviser,
  stabiliteInitiale,
  W,
  type EtatCarte,
  type Note,
} from "./index";

const T0 = new Date("2026-09-10T08:00:00.000Z");
const plus = (jours: number) =>
  new Date(T0.getTime() + jours * 86_400_000);

const NOTES: Note[] = [1, 2, 3, 4];

/** Carte mûre servant de point de départ commun. */
const carte = (p: Partial<EtatCarte> = {}): EtatCarte => ({
  stability: 20,
  difficulty: 5,
  due: "2026-09-10",
  lastReview: T0.toISOString(),
  reps: 3,
  lapses: 0,
  ...p,
});

// ── Paramètres ──────────────────────────────────────────────────────────────

describe("paramètres", () => {
  it("FSRS-4.5 a exactement 17 poids, tous finis", () => {
    expect(W).toHaveLength(17);
    for (const w of W) expect(Number.isFinite(w)).toBe(true);
  });
});

// ── Rétrievabilité et intervalle ────────────────────────────────────────────

describe("retrievabilite", () => {
  it("vaut 1 juste après la révision", () => {
    expect(retrievabilite(0, 20)).toBeCloseTo(1, 12);
  });

  it("vaut exactement la rétention cible au bout de S jours", () => {
    // C'est la définition de la stabilité, et la raison du choix FACTOR=19/81.
    for (const s of [1, 5, 20, 365]) {
      expect(retrievabilite(s, s)).toBeCloseTo(RETENTION_CIBLE, 10);
    }
  });

  it("décroît avec le temps et croît avec la stabilité", () => {
    expect(retrievabilite(10, 20)).toBeGreaterThan(retrievabilite(30, 20));
    expect(retrievabilite(10, 40)).toBeGreaterThan(retrievabilite(10, 20));
  });
});

describe("intervalle", () => {
  it("à la rétention par défaut, l'intervalle est la stabilité", () => {
    for (const s of [3, 21, 100, 400]) expect(intervalle(s)).toBe(Math.round(s));
  });

  it("une rétention plus exigeante raccourcit l'intervalle", () => {
    expect(intervalle(100, 0.97)).toBeLessThan(intervalle(100, 0.9));
    expect(intervalle(100, 0.8)).toBeGreaterThan(intervalle(100, 0.9));
  });

  it("vaut au moins un jour et reste croissant en S", () => {
    expect(intervalle(0.01)).toBe(1);
    let prec = 0;
    for (const s of [1, 2, 10, 50, 200, 1000]) {
      const i = intervalle(s);
      expect(i).toBeGreaterThanOrEqual(prec);
      prec = i;
    }
  });
});

// ── Carte neuve ─────────────────────────────────────────────────────────────

describe("première révision", () => {
  it("la stabilité initiale croît avec la note", () => {
    const s = NOTES.map(stabiliteInitiale);
    expect(s[0]).toBeLessThan(s[1]);
    expect(s[1]).toBeLessThan(s[2]);
    expect(s[2]).toBeLessThan(s[3]);
  });

  it("la difficulté initiale décroît strictement avec la note", () => {
    const d = NOTES.map(difficulteInitiale);
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeLessThan(d[i - 1]);
  });

  it("la difficulté initiale ne sature pas aux bornes", () => {
    // Garde-fou contre un mauvais appariement formule / poids : la forme
    // exponentielle de FSRS-5 appliquée aux poids de FSRS-4.5 écrase D_0(3)
    // et D_0(4) sur la borne basse, et le terme de difficulté devient inerte
    // sans que rien ne casse visiblement.
    const d = NOTES.map(difficulteInitiale);
    for (const x of d) {
      expect(x).toBeGreaterThanOrEqual(D_MIN);
      expect(x).toBeLessThanOrEqual(D_MAX);
    }
    for (const note of [2, 3] as Note[]) {
      expect(difficulteInitiale(note)).toBeGreaterThan(D_MIN);
      expect(difficulteInitiale(note)).toBeLessThan(D_MAX);
    }
    // Une carte réussie et une carte facile ne doivent pas se confondre.
    expect(difficulteInitiale(4)).not.toBeCloseTo(difficulteInitiale(3), 3);
  });

  it("la difficulté influence réellement la stabilité obtenue", () => {
    // Si D est constante, ce test passe quand même — d'où le précédent. Celui
    // -ci vérifie l'autre bout de la chaîne : le terme (11 − D) est utilisé.
    const facile = reviser(carte({ difficulty: 1 }), 3, plus(20));
    const dure = reviser(carte({ difficulty: 10 }), 3, plus(20));
    expect(facile.stability / dure.stability).toBeGreaterThan(1.5);
  });

  it("compte une répétition, et une rechute seulement si oublié", () => {
    expect(premiereRevision(1, T0).lapses).toBe(1);
    expect(premiereRevision(3, T0).lapses).toBe(0);
    for (const n of NOTES) expect(premiereRevision(n, T0).reps).toBe(1);
  });

  it("une carte neuve est due immédiatement", () => {
    expect(estDue(carteNeuve(T0), T0)).toBe(true);
  });

  it("réviser une carte jamais vue équivaut à une première révision", () => {
    expect(reviser(carteNeuve(T0), 3, T0)).toEqual(premiereRevision(3, T0));
  });
});

// ── Monotonie en la note ────────────────────────────────────────────────────

describe("effet de la note", () => {
  const apres = NOTES.map((n) => reviser(carte(), n, plus(20)));

  it("une meilleure note donne une stabilité plus grande", () => {
    for (let i = 1; i < apres.length; i++) {
      expect(apres[i].stability).toBeGreaterThan(apres[i - 1].stability);
    }
  });

  it("une meilleure note donne une difficulté plus basse", () => {
    for (let i = 1; i < apres.length; i++) {
      expect(apres[i].difficulty).toBeLessThan(apres[i - 1].difficulty);
    }
  });

  it("un oubli ne peut jamais augmenter la stabilité", () => {
    for (const s of [0.5, 5, 20, 200, 3000]) {
      for (const d of [1, 5, 10]) {
        for (const delai of [0, 1, 10, 500]) {
          const avant = carte({ stability: s, difficulty: d });
          const apresOubli = reviser(avant, 1, plus(delai));
          expect(apresOubli.stability).toBeLessThanOrEqual(s);
        }
      }
    }
  });

  it("compte les rechutes et les répétitions", () => {
    const c = carte({ reps: 7, lapses: 2 });
    expect(reviser(c, 1, plus(20))).toMatchObject({ reps: 8, lapses: 3 });
    expect(reviser(c, 3, plus(20))).toMatchObject({ reps: 8, lapses: 2 });
  });
});

// ── Effet d'espacement et difficulté ────────────────────────────────────────

describe("propriétés de l'apprentissage", () => {
  it("réviser plus tard, en réussissant, renforce davantage", () => {
    // Effet d'espacement : à note égale, un rappel plus difficile (R plus bas)
    // apporte un gain de stabilité plus grand.
    const court = reviser(carte(), 3, plus(2));
    const long = reviser(carte(), 3, plus(40));
    expect(long.stability).toBeGreaterThan(court.stability);
  });

  it("une carte plus difficile progresse moins", () => {
    const facile = reviser(carte({ difficulty: 2 }), 3, plus(20));
    const dure = reviser(carte({ difficulty: 9 }), 3, plus(20));
    expect(facile.stability).toBeGreaterThan(dure.stability);
  });

  it("la difficulté reste dans [1, 10] après une longue série d'oublis", () => {
    let c = carte();
    for (let i = 0; i < 50; i++) c = reviser(c, 1, plus(i + 1));
    expect(c.difficulty).toBeGreaterThanOrEqual(D_MIN);
    expect(c.difficulty).toBeLessThanOrEqual(D_MAX);
  });

  it("la difficulté reste dans [1, 10] après une longue série de réussites", () => {
    let c = carte();
    for (let i = 0; i < 50; i++) c = reviser(c, 4, plus(i * 10 + 1));
    expect(c.difficulty).toBeGreaterThanOrEqual(D_MIN);
    expect(c.difficulty).toBeLessThanOrEqual(D_MAX);
    expect(c.stability).toBeLessThanOrEqual(36500);
  });
});

// ── Échéances ───────────────────────────────────────────────────────────────

describe("échéances", () => {
  it("l'échéance est la date de révision plus l'intervalle", () => {
    const c = reviser(carte(), 3, T0);
    const attendu = new Date(
      T0.getTime() + intervalle(c.stability) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    expect(c.due).toBe(attendu);
  });

  it("une carte révisée aujourd'hui n'est plus due aujourd'hui", () => {
    expect(estDue(reviser(carte(), 3, T0), T0)).toBe(false);
  });

  it("joursEcoules ne renvoie jamais de valeur négative", () => {
    expect(joursEcoules(T0.toISOString(), plus(-5))).toBe(0);
    expect(joursEcoules(null, T0)).toBe(0);
    expect(joursEcoules(T0.toISOString(), plus(3))).toBeCloseTo(3, 9);
  });

  it("le seuil de maîtrise du §4 est atteignable par des révisions réussies", () => {
    // Le prompt exige une stabilité > 21 jours pour `mastered`. On vérifie
    // qu'une carte correctement révisée y arrive, et en combien de fois.
    let c: EtatCarte = premiereRevision(3, T0);
    let jours = 0;
    let revisions = 1;
    while (c.stability <= 21 && revisions < 20) {
      jours += intervalle(c.stability);
      c = reviser(c, 3, plus(jours));
      revisions++;
    }
    expect(c.stability).toBeGreaterThan(21);
    expect(revisions).toBeLessThanOrEqual(6);
  });
});
