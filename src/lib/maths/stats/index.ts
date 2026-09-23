import type { Graph, ProgressState } from "@/lib/maths/graph/types";
import { retrievabilite } from "@/lib/maths/fsrs";
import { SEUILS, type Evidence } from "@/lib/maths/progression/rules";

/**
 * Agrégats du tableau de bord. Fonctions pures : elles prennent des données
 * déjà lues et ne touchent ni au système de fichiers ni à la base, ce qui les
 * rend testables sans monter d'application.
 */

export type EtatCarteBrut = {
  nodeId: string;
  stability: number;
  due: string;
  lastReview: string | null;
  lapses: number;
};

export type TentativeBrute = {
  nodeId: string;
  difficulty: number;
  outcome: "resolu-seul" | "resolu-avec-indice" | "echec" | "abandonne";
  minutesSpent: number;
};

const REUSSI = ["resolu-seul", "resolu-avec-indice"];

const jour = (d: Date) => d.toISOString().slice(0, 10);

const ajoute = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

// ── Heures par niveau ───────────────────────────────────────────────────────

export type LigneDomaine = {
  id: string;
  titre: string;
  heuresEstimees: number;
  heuresAcquises: number;
  minutesReelles: number;
  concepts: number;
  conceptsAcquis: number;
};

/**
 * Heures estimées, heures « acquises » (celles des concepts au moins acquis) et
 * temps réellement passé, par domaine. Les trois ne mesurent pas la même chose
 * et sont volontairement affichés côte à côte : l'écart entre estimé et réel
 * est la seule façon de savoir si les estimations du graphe valent quelque
 * chose.
 */
export function heuresParDomaine(
  graph: Graph,
  etats: Map<string, ProgressState>,
  minutesParNoeud: Map<string, number>,
): LigneDomaine[] {
  return graph.domains.map((d) => {
    const concepts = graph.concepts.filter((c) => c.ancestors[0] === d.id);
    const acquis = concepts.filter((c) =>
      ["learned", "mastered"].includes(etats.get(c.id) ?? ""),
    );
    return {
      id: d.id,
      titre: d.title.split(" — ")[0],
      heuresEstimees: concepts.reduce((a, c) => a + c.estimatedHours, 0),
      heuresAcquises: acquis.reduce((a, c) => a + c.estimatedHours, 0),
      minutesReelles: concepts.reduce(
        (a, c) => a + (minutesParNoeud.get(c.id) ?? 0),
        0,
      ),
      concepts: concepts.length,
      conceptsAcquis: acquis.length,
    };
  });
}

// ── Réussite par tag ────────────────────────────────────────────────────────

export type LigneTag = {
  tag: string;
  essais: number;
  reussis: number;
  sansIndice: number;
  taux: number;
};

/**
 * Taux de réussite par tag, sur la meilleure tentative de chaque exercice.
 * Un exercice appartient à tous les tags de son nœud : les colonnes ne
 * s'additionnent donc pas, et c'est voulu — la question posée est « sur quel
 * type de contenu est-ce que je bloque », pas « comment se répartit mon
 * travail ».
 */
export function reussiteParTag(
  graph: Graph,
  tentatives: TentativeBrute[],
): LigneTag[] {
  const par = new Map<string, LigneTag>();
  for (const t of tentatives) {
    const node = graph.byId.get(t.nodeId);
    if (!node) continue;
    for (const tag of node.tags) {
      const l =
        par.get(tag) ??
        ({ tag, essais: 0, reussis: 0, sansIndice: 0, taux: 0 } as LigneTag);
      l.essais++;
      if (REUSSI.includes(t.outcome)) l.reussis++;
      if (t.outcome === "resolu-seul") l.sansIndice++;
      par.set(tag, l);
    }
  }
  return [...par.values()]
    .map((l) => ({ ...l, taux: l.essais === 0 ? 0 : l.reussis / l.essais }))
    .sort((a, b) => a.taux - b.taux || b.essais - a.essais);
}

// ── Courbe d'oubli et charge à venir ────────────────────────────────────────

export type PointRetention = { jour: number; retention: number; cartes: number };

/**
 * Rétention moyenne prévue par l'ordonnanceur sur les prochains jours, sur les
 * seules cartes déjà révisées — une carte neuve n'a pas de stabilité, la faire
 * compter pour 0 écraserait la courbe sans rien dire.
 *
 * C'est une prévision, pas une mesure : la courbe empirique demandera plusieurs
 * centaines de révisions dans `review_log`.
 */
export function courbeOubli(
  cartes: EtatCarteBrut[],
  maintenant: Date,
  jours = 60,
): PointRetention[] {
  const vues = cartes.filter((c) => c.lastReview !== null && c.stability > 0);
  const out: PointRetention[] = [];
  for (let j = 0; j <= jours; j++) {
    if (vues.length === 0) {
      out.push({ jour: j, retention: 0, cartes: 0 });
      continue;
    }
    const cible = ajoute(maintenant, j).getTime();
    let somme = 0;
    for (const c of vues) {
      const t = Math.max(
        0,
        (cible - new Date(c.lastReview!).getTime()) / 86_400_000,
      );
      somme += retrievabilite(t, c.stability);
    }
    out.push({ jour: j, retention: somme / vues.length, cartes: vues.length });
  }
  return out;
}

export type PointCharge = { date: string; jour: number; cartes: number };

/** Nombre de cartes échues chaque jour. Le retard est reporté sur le jour 0. */
export function chargeAVenir(
  cartes: EtatCarteBrut[],
  maintenant: Date,
  jours = 30,
): PointCharge[] {
  const aujourdhui = jour(maintenant);
  const out: PointCharge[] = [];
  for (let j = 0; j <= jours; j++) {
    const date = jour(ajoute(maintenant, j));
    const n = cartes.filter((c) =>
      j === 0 ? c.due <= aujourdhui : c.due === date,
    ).length;
    out.push({ date, jour: j, cartes: n });
  }
  return out;
}

// ── Nœuds fragiles ──────────────────────────────────────────────────────────

export type Fragilite = {
  nodeId: string;
  titre: string;
  etat: ProgressState;
  raisons: string[];
};

export const RAISONS = {
  indices: "réussi surtout avec indices",
  rechutes: "cartes en rechute",
  stabilite: "rétention sous le seuil",
} as const;

/**
 * Un nœud est fragile quand ce qui le fait tenir est plus faible que son état
 * ne le laisse croire. Trois symptômes, cumulables :
 *
 *  - plus de la moitié des exercices réussis l'ont été avec un indice ;
 *  - au moins une carte a rechuté deux fois ou plus ;
 *  - le nœud est acquis ou maîtrisé, mais une de ses cartes déjà révisées est
 *    retombée sous le seuil de stabilité du §4.
 *
 * Les nœuds jamais commencés ne sont pas fragiles, ils sont vides : on ne
 * regarde que ce qui est au moins en cours.
 */
export function noeudsFragiles(
  graph: Graph,
  etats: Map<string, ProgressState>,
  preuves: Map<string, Evidence>,
  cartes: EtatCarteBrut[],
): Fragilite[] {
  const parNoeud = new Map<string, EtatCarteBrut[]>();
  for (const c of cartes) {
    parNoeud.set(c.nodeId, [...(parNoeud.get(c.nodeId) ?? []), c]);
  }

  const out: Fragilite[] = [];
  for (const node of graph.concepts) {
    const etat = etats.get(node.id) ?? "locked";
    if (etat === "locked" || etat === "available") continue;

    const ev = preuves.get(node.id);
    const raisons: string[] = [];

    if (ev) {
      const reussis = ev.exercises.filter((e) => REUSSI.includes(e.outcome));
      const avecIndice = reussis.filter(
        (e) => e.outcome === "resolu-avec-indice",
      );
      if (reussis.length >= 2 && avecIndice.length / reussis.length > 0.5) {
        raisons.push(RAISONS.indices);
      }
    }

    const mesCartes = parNoeud.get(node.id) ?? [];
    if (mesCartes.some((c) => c.lapses >= 2)) raisons.push(RAISONS.rechutes);
    if (
      ["learned", "mastered"].includes(etat) &&
      mesCartes.some(
        (c) => c.lastReview !== null && c.stability < SEUILS.stabiliteJours,
      )
    ) {
      raisons.push(RAISONS.stabilite);
    }

    if (raisons.length > 0) {
      out.push({ nodeId: node.id, titre: node.title, etat, raisons });
    }
  }
  return out.sort((a, b) => b.raisons.length - a.raisons.length);
}
