import { addDaysISO, localDate, mondayOf } from "@/lib/agenda/zoned";

/**
 * La couche de jeu de /maths (décision D26) : XP, niveaux, série, objectif du
 * jour. Rien n'est stocké — tout se dérive de ce que la base garde déjà
 * (capsules terminées, tentatives, journal des révisions, journal de
 * session), comme les états de progression. Changer un barème recalcule donc
 * tout l'historique, sans migration.
 *
 * Règle de fond : l'XP mesure l'effort et ne nourrit jamais les règles de
 * progression. `learned` et `mastered` restent calculés par
 * progression/rules.ts à partir des preuves, et rien ici n'y touche.
 *
 * Les jours sont des jours de Paris, comme partout sur le site.
 */

export const FUSEAU = "Europe/Paris";

export const jourDe = (iso: string): string => localDate(new Date(iso), FUSEAU);

// ── Barème ──────────────────────────────────────────────────────────────────

export const BAREME = {
  capsule: 10,
  /** Checkpoint réussi au premier essai. */
  premierEssai: 5,
  /**
   * Valeur d'un exercice selon sa meilleure issue, par point de difficulté.
   * Seules les améliorations rapportent : refaire un exercice déjà réussi ne
   * rapporte rien, et déclarer un échec n'en retire jamais — on n'a aucun
   * intérêt à taire ses échecs.
   */
  exercice: {
    abandonne: 1,
    echec: 2,
    "resolu-avec-indice": 5,
    "resolu-seul": 10,
  },
  /** Premier exercice de difficulté ≥ 4 réussi sur un nœud. */
  testDeSortie: 50,
  /** Par carte distincte révisée dans la journée. */
  revision: 1,
} as const;

export type Issue = keyof typeof BAREME.exercice;

export type TypeEvenement =
  | "capsule"
  | "premier-essai"
  | "exercice"
  | "test-de-sortie"
  | "revision";

export type Evenement = {
  type: TypeEvenement;
  /** Instant ISO ; pour les révisions, agrégées par jour, midi du jour. */
  date: string;
  jour: string;
  nodeId: string;
  xp: number;
  /** Capsule, exercice, ou nombre de cartes : de quoi l'afficher. */
  detail: string;
};

export type EntreesJeu = {
  capsules: readonly {
    nodeId: string;
    moduleId: string;
    completedAt: string;
    checkpointTries: number | null;
  }[];
  tentatives: readonly {
    exerciseKey: string;
    nodeId: string;
    difficulty: number;
    outcome: Issue;
    createdAt: string;
  }[];
  revisions: readonly { jour: string; nodeId: string; cartes: number }[];
  /** Journal de session : compte pour la série, pas pour l'XP. */
  sessions: readonly { createdAt: string }[];
};

const REUSSI: Issue[] = ["resolu-seul", "resolu-avec-indice"];

/** Seuil de difficulté du test de sortie, aligné sur SEUILS.difficulteHaute. */
export const DIFFICULTE_TEST = 4;

/** Chronologie des gains d'XP, de la plus ancienne à la plus récente. */
export function evenements(e: EntreesJeu): Evenement[] {
  const out: Evenement[] = [];

  for (const c of e.capsules) {
    const base = { date: c.completedAt, jour: jourDe(c.completedAt), nodeId: c.nodeId, detail: c.moduleId };
    out.push({ ...base, type: "capsule", xp: BAREME.capsule });
    if (c.checkpointTries === 1) out.push({ ...base, type: "premier-essai", xp: BAREME.premierEssai });
  }

  const tentatives = [...e.tentatives].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const meilleure = new Map<string, number>();
  const testFait = new Set<string>();
  for (const t of tentatives) {
    const valeur = BAREME.exercice[t.outcome] * t.difficulty;
    const avant = meilleure.get(t.exerciseKey) ?? 0;
    const base = { date: t.createdAt, jour: jourDe(t.createdAt), nodeId: t.nodeId, detail: t.exerciseKey };
    if (valeur > avant) {
      meilleure.set(t.exerciseKey, valeur);
      out.push({ ...base, type: "exercice", xp: valeur - avant });
    }
    if (t.difficulty >= DIFFICULTE_TEST && REUSSI.includes(t.outcome) && !testFait.has(t.nodeId)) {
      testFait.add(t.nodeId);
      out.push({ ...base, type: "test-de-sortie", xp: BAREME.testDeSortie });
    }
  }

  for (const r of e.revisions) {
    if (r.cartes <= 0) continue;
    out.push({
      type: "revision",
      date: `${r.jour}T12:00:00+02:00`,
      jour: r.jour,
      nodeId: r.nodeId,
      xp: r.cartes * BAREME.revision,
      detail: String(r.cartes),
    });
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export const xpTotal = (evs: readonly Evenement[]) => evs.reduce((a, e) => a + e.xp, 0);

/** XP par jour, pour les `n` derniers jours jusqu'à `aujourdhui` inclus. */
export function xpParJour(
  evs: readonly Evenement[],
  aujourdhui: string,
  n: number,
): { jour: string; xp: number }[] {
  const parJour = new Map<string, number>();
  for (const e of evs) parJour.set(e.jour, (parJour.get(e.jour) ?? 0) + e.xp);
  return Array.from({ length: n }, (_, i) => {
    const jour = addDaysISO(aujourdhui, i - n + 1);
    return { jour, xp: parJour.get(jour) ?? 0 };
  });
}

// ── Niveaux ─────────────────────────────────────────────────────────────────

/**
 * Atteindre le niveau n demande 100·n(n−1)/2 XP au total : 100 pour le 2,
 * 300 pour le 3, 600 pour le 4… Chaque niveau coûte 100 XP de plus que le
 * précédent. Un nœud complet — capsules, exercices, test de sortie, quelques
 * semaines de révisions — rapporte de l'ordre de 500 XP : les premiers
 * niveaux tombent vite, les suivants suivent le rythme du parcours.
 */
export const seuilNiveau = (n: number) => (100 * n * (n - 1)) / 2;

export function niveau(xp: number): {
  niveau: number;
  depuis: number;
  jusqua: number;
  /** Part du niveau courant déjà faite, entre 0 et 1. */
  part: number;
} {
  let n = 1;
  while (seuilNiveau(n + 1) <= xp) n++;
  const depuis = seuilNiveau(n);
  const jusqua = seuilNiveau(n + 1);
  return { niveau: n, depuis, jusqua, part: (xp - depuis) / (jusqua - depuis) };
}

// ── Série ───────────────────────────────────────────────────────────────────

/**
 * Jours actifs : au moins une capsule terminée, une tentative d'exercice, une
 * carte révisée ou une séance au journal. Le seuil est bas exprès — la série
 * récompense la régularité, pas le volume ; l'objectif du jour porte le
 * volume.
 */
export function joursActifs(e: EntreesJeu): Set<string> {
  const s = new Set<string>();
  for (const c of e.capsules) s.add(jourDe(c.completedAt));
  for (const t of e.tentatives) s.add(jourDe(t.createdAt));
  for (const r of e.revisions) if (r.cartes > 0) s.add(r.jour);
  for (const x of e.sessions) s.add(jourDe(x.createdAt));
  return s;
}

export const JOKERS_PAR_SEMAINE = 1;

export type Serie = {
  /** Jours consécutifs, jokers compris, jusqu'à aujourd'hui ou hier. */
  longueur: number;
  /** Aujourd'hui compte déjà. Sinon la série tient encore, jusqu'à minuit. */
  aujourdhui: boolean;
  /** Jours manqués couverts par un joker dans la série en cours. */
  jokers: string[];
  /** Le joker de la semaine en cours est encore disponible. */
  jokerDisponible: boolean;
  /** Plus longue série jamais tenue, celle en cours comprise. */
  record: number;
};

/**
 * Un jour manqué ne casse pas la série si le joker de sa semaine (lundi à
 * dimanche) n'a pas servi, et si la série reprend dès le lendemain : un joker
 * comble un trou d'un jour, jamais deux. Aujourd'hui, tant qu'il n'est pas
 * fini, ne casse rien.
 */
export function serie(actifs: ReadonlySet<string>, aujourdhui: string): Serie {
  const fait = actifs.has(aujourdhui);
  // Aujourd'hui pas encore actif : on part d'hier. Si hier manque aussi, le
  // joker peut le couvrir — la série tient, pourvu qu'aujourd'hui compte.
  let d = fait ? aujourdhui : addDaysISO(aujourdhui, -1);
  let longueur = 0;
  const jokers: string[] = [];
  const semaines = new Map<string, number>();
  for (;;) {
    if (actifs.has(d)) {
      longueur++;
    } else {
      const sem = mondayOf(d);
      const pris = semaines.get(sem) ?? 0;
      if (pris < JOKERS_PAR_SEMAINE && actifs.has(addDaysISO(d, -1))) {
        semaines.set(sem, pris + 1);
        jokers.push(d);
        longueur++;
      } else break;
    }
    d = addDaysISO(d, -1);
  }
  const semaine = mondayOf(aujourdhui);
  return {
    longueur,
    aujourdhui: fait,
    jokers,
    jokerDisponible: (semaines.get(semaine) ?? 0) < JOKERS_PAR_SEMAINE,
    record: Math.max(longueur, recordSerie(actifs)),
  };
}

/** Plus longue série de l'historique, avec la même règle de joker. */
export function recordSerie(actifs: ReadonlySet<string>): number {
  const jours = [...actifs].sort();
  if (jours.length === 0) return 0;
  let best = 0;
  let courant = 0;
  let semaines = new Map<string, number>();
  for (let d = jours[0]; d <= jours[jours.length - 1]; d = addDaysISO(d, 1)) {
    if (actifs.has(d)) {
      courant++;
    } else {
      const sem = mondayOf(d);
      const pris = semaines.get(sem) ?? 0;
      if (courant > 0 && pris < JOKERS_PAR_SEMAINE && actifs.has(addDaysISO(d, 1))) {
        semaines.set(sem, pris + 1);
        courant++;
      } else {
        courant = 0;
        semaines = new Map();
      }
    }
    best = Math.max(best, courant);
  }
  return best;
}

// ── Objectif du jour ────────────────────────────────────────────────────────

export type Objectif = { libelle: string; fait: boolean; detail: string };

/**
 * Deux gestes par jour : avancer (une capsule ou un exercice) et entretenir
 * (vider la file de révision). La file vide se lit sur son état présent, pas
 * sur l'historique — c'est pourquoi l'objectif ne rapporte pas d'XP : il
 * n'est pas reconstructible après coup.
 */
export function objectifDuJour(args: {
  capsulesAujourdhui: number;
  tentativesAujourdhui: number;
  fileRestante: number;
  cartesAujourdhui: number;
}): Objectif[] {
  const avance = args.capsulesAujourdhui + args.tentativesAujourdhui;
  return [
    {
      libelle: "avancer : une capsule ou un exercice",
      fait: avance > 0,
      detail:
        avance === 0
          ? "rien encore aujourd'hui"
          : [
              args.capsulesAujourdhui && `${args.capsulesAujourdhui} capsule${args.capsulesAujourdhui > 1 ? "s" : ""}`,
              args.tentativesAujourdhui && `${args.tentativesAujourdhui} exercice${args.tentativesAujourdhui > 1 ? "s" : ""}`,
            ]
              .filter(Boolean)
              .join(", "),
    },
    {
      libelle: "entretenir : vider la file de révision",
      fait: args.fileRestante === 0,
      detail:
        args.fileRestante === 0
          ? args.cartesAujourdhui > 0
            ? `${args.cartesAujourdhui} carte${args.cartesAujourdhui > 1 ? "s" : ""} révisée${args.cartesAujourdhui > 1 ? "s" : ""}`
            : "rien de dû"
          : `${args.fileRestante} carte${args.fileRestante > 1 ? "s" : ""} en attente`,
    },
  ];
}
