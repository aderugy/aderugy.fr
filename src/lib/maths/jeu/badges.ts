import { DIFFICULTE_TEST, jourDe, type EntreesJeu } from "./index";

/**
 * Badges (décision D26). Peu nombreux, et chacun attaché à un vrai jalon du
 * parcours : aucun badge ne s'obtient en cliquant. Tous sont dérivés ; un
 * badge dont la condition repose sur un état qui peut se perdre (la maîtrise)
 * reste acquis, comme `mastered_at` garde la première date.
 */

export type Badge = {
  id: string;
  nom: string;
  description: string;
  obtenu: boolean;
  /** Jour d'obtention, quand l'historique permet de le dater. */
  jour: string | null;
  /** Avancement vers le badge, pour ceux qui se comptent. */
  progres: { fait: number; but: number } | null;
};

export type EntreesBadges = EntreesJeu & {
  /** Nœuds dont toutes les capsules sont terminées. */
  noeudsLus: number;
  /** Nœuds maîtrisés un jour (état actuel ou date de première maîtrise). */
  noeudsMaitrises: number;
  /** Plus longue série tenue. */
  recordSerie: number;
};

/** Jour où le n-ième élément d'une liste de jours triée a été atteint. */
function nieme(jours: string[], n: number): string | null {
  const tries = [...jours].sort();
  return tries.length >= n ? tries[n - 1] : null;
}

function compte(
  id: string,
  nom: string,
  description: string,
  jours: string[],
  but: number,
  datable = true,
): Badge {
  const fait = jours.length;
  return {
    id,
    nom,
    description,
    obtenu: fait >= but,
    jour: datable && fait >= but ? nieme(jours, but) : null,
    progres: but > 1 ? { fait: Math.min(fait, but), but } : null,
  };
}

export function badges(e: EntreesBadges): Badge[] {
  const capsules = e.capsules.map((c) => jourDe(c.completedAt));
  const sansFaute = e.capsules
    .filter((c) => c.checkpointTries === 1)
    .map((c) => jourDe(c.completedAt));

  // Premier succès par exercice difficile, et par nœud pour le test de sortie.
  const difficilesSeul = new Map<string, string>();
  const tests = new Map<string, string>();
  for (const t of [...e.tentatives].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (t.difficulty < DIFFICULTE_TEST) continue;
    const jour = jourDe(t.createdAt);
    if (t.outcome === "resolu-seul" && !difficilesSeul.has(t.exerciseKey))
      difficilesSeul.set(t.exerciseKey, jour);
    if ((t.outcome === "resolu-seul" || t.outcome === "resolu-avec-indice") && !tests.has(t.nodeId))
      tests.set(t.nodeId, jour);
  }

  // Révisions cumulées, jour par jour, pour dater la centième carte.
  const parJour = new Map<string, number>();
  for (const r of e.revisions) parJour.set(r.jour, (parJour.get(r.jour) ?? 0) + r.cartes);
  const cartesJours: string[] = [];
  for (const [jour, n] of [...parJour].sort(([a], [b]) => a.localeCompare(b)))
    for (let i = 0; i < n; i++) cartesJours.push(jour);

  const plein = (n: number) => Array.from({ length: n }, () => "");

  return [
    compte("premiere-capsule", "Premier pas", "Terminer une capsule.", capsules, 1),
    compte("noeud-lu", "Cours lu", "Terminer toutes les capsules d'un nœud.", plein(e.noeudsLus), 1, false),
    compte(
      "sans-faute",
      "Sans faute",
      "Réussir cinq checkpoints du premier coup.",
      sansFaute,
      5,
    ),
    compte(
      "test-de-sortie",
      "Test de sortie",
      `Réussir un exercice de difficulté ${DIFFICULTE_TEST} ou plus.`,
      [...tests.values()],
      1,
    ),
    compte(
      "main-sure",
      "Main sûre",
      `Résoudre seul dix exercices de difficulté ${DIFFICULTE_TEST} ou plus.`,
      [...difficilesSeul.values()],
      10,
    ),
    compte("cent-cartes", "Cent cartes", "Réviser cent cartes.", cartesJours, 100),
    compte(
      "premiere-maitrise",
      "Maîtrise",
      "Maîtriser un nœud : test de sortie et toutes ses cartes au-dessus de 21 jours.",
      plein(e.noeudsMaitrises),
      1,
      false,
    ),
    compte("serie-7", "Une semaine", "Tenir une série de 7 jours.", plein(e.recordSerie), 7, false),
    compte("serie-30", "Un mois", "Tenir une série de 30 jours.", plein(e.recordSerie), 30, false),
  ];
}
