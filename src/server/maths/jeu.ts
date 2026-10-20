import "server-only";
import type { Graph } from "@/lib/maths/graph/types";
import { localDate } from "@/lib/agenda/zoned";
import { loadModules } from "@/lib/maths/content";
import { evidenceParNoeud } from "@/lib/maths/progression/evidence";
import { computeStates } from "@/lib/maths/progression/rules";
import { coursTermine } from "@/lib/maths/progression/capsules";
import { fileDeRevision } from "@/lib/maths/revision/queue";
import {
  evenements,
  FUSEAU,
  joursActifs,
  niveau,
  objectifDuJour,
  serie,
  xpParJour,
  xpTotal,
  type EntreesJeu,
  type Evenement,
  type Objectif,
  type Serie,
} from "@/lib/maths/jeu";
import { badges, type Badge } from "@/lib/maths/jeu/badges";
import type { DonneesMaths, RevisionsJour } from "./data";

/** Tout ce que la page Rythme, l'en-tête et le connecteur affichent. */
export type Bilan = {
  aujourdhui: string;
  xp: number;
  niveau: ReturnType<typeof niveau>;
  serie: Serie;
  objectif: Objectif[];
  /** XP des 14 derniers jours, du plus ancien à aujourd'hui. */
  recents: { jour: string; xp: number }[];
  /** Derniers gains, du plus récent au plus ancien. */
  journal: Evenement[];
  badges: Badge[];
};

export function entreesJeu(donnees: DonneesMaths, revisions: RevisionsJour[]): EntreesJeu {
  return {
    capsules: donnees.capsules,
    tentatives: donnees.attempts,
    revisions,
    sessions: donnees.sessions,
  };
}

/**
 * Le bilan de jeu, à partir de l'instantané d'un utilisateur. Pur à
 * l'exception de la lecture du contenu sur disque (capsules, cartes).
 */
export function bilan(
  graph: Graph,
  donnees: DonneesMaths,
  revisions: RevisionsJour[],
  maintenant: Date,
): Bilan {
  const aujourdhui = localDate(maintenant, FUSEAU);
  const entrees = entreesJeu(donnees, revisions);
  const evs = evenements(entrees);
  const total = xpTotal(evs);
  const s = serie(joursActifs(entrees), aujourdhui);

  const etats = computeStates(graph, evidenceParNoeud(graph, donnees));
  const maitrises = new Set(
    [...etats].filter(([, e]) => e === "mastered").map(([id]) => id),
  );
  for (const p of donnees.progress.values()) if (p.masteredAt) maitrises.add(p.nodeId);

  let noeudsLus = 0;
  for (const [nodeId, faites] of donnees.modules) {
    const node = graph.byId.get(nodeId);
    if (node && coursTermine(loadModules(node), faites)) noeudsLus++;
  }

  const duJour = (iso: string) => localDate(new Date(iso), FUSEAU) === aujourdhui;
  return {
    aujourdhui,
    xp: total,
    niveau: niveau(total),
    serie: s,
    objectif: objectifDuJour({
      capsulesAujourdhui: donnees.capsules.filter((c) => duJour(c.completedAt)).length,
      tentativesAujourdhui: donnees.attempts.filter((t) => duJour(t.createdAt)).length,
      fileRestante: fileDeRevision(graph, donnees, maintenant).length,
      cartesAujourdhui: revisions
        .filter((r) => r.jour === aujourdhui)
        .reduce((a, r) => a + r.cartes, 0),
    }),
    recents: xpParJour(evs, aujourdhui, 14),
    journal: [...evs].reverse().slice(0, 30),
    badges: badges({
      ...entrees,
      noeudsLus,
      noeudsMaitrises: maitrises.size,
      recordSerie: s.record,
    }),
  };
}
