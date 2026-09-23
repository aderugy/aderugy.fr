import "server-only";
import { cardKey, type Card } from "@/lib/maths/content";
import type { DonneesMaths } from "@/server/maths/data";
import { cartesParNoeud } from "@/lib/maths/progression/evidence";
import type { Graph } from "@/lib/maths/graph/types";
import { carteNeuve, estDue, type EtatCarte } from "@/lib/maths/fsrs";

export type CarteDue = {
  cardKey: string;
  nodeId: string;
  cardId: string;
  nodeTitle: string;
  /** Ancre de la section d'origine, pour ramener au cours en cas d'échec. */
  ref: string;
  front: string;
  back: string;
  etat: EtatCarte;
  nouvelle: boolean;
};

/**
 * Plafond de cartes neuves par file. Sans lui, ouvrir un nœud fraîchement
 * rédigé jette d'un coup toutes ses cartes dans la même session, et
 * l'ordonnanceur les ramène ensuite toutes en même temps — l'effet
 * d'avalanche classique. Le plafond est sans état : il s'applique à la file,
 * pas à la journée.
 */
export const NOUVELLES_MAX = 20;

/**
 * File de révision, entrelacée sur tout le corpus.
 *
 * L'entrelacement entre nœuds éloignés est ce qui fait l'efficacité de la
 * répétition espacée (décision D1) : les cartes sont donc distribuées en
 * tourniquet entre les nœuds, et non groupées par nœud.
 */
export function fileDeRevision(
  graph: Graph,
  donnees: DonneesMaths,
  maintenant: Date,
): CarteDue[] {
  const etats = donnees.reviewStates;
  const cartes = cartesParNoeud(graph);

  const parNoeud: CarteDue[][] = [];
  let nouvellesRetenues = 0;

  for (const [nodeId, liste] of cartes) {
    const node = graph.byId.get(nodeId);
    if (!node) continue;
    const dues: CarteDue[] = [];

    for (const c of liste) {
      const key = cardKey(nodeId, c.id);
      const row = etats.get(key);
      const etat: EtatCarte = row
        ? {
            stability: row.stability,
            difficulty: row.difficulty,
            due: row.due,
            lastReview: row.lastReview,
            reps: row.reps,
            lapses: row.lapses,
          }
        : carteNeuve(maintenant);
      if (!estDue(etat, maintenant)) continue;
      const nouvelle = etat.lastReview === null;
      if (nouvelle) {
        if (nouvellesRetenues >= NOUVELLES_MAX) continue;
        nouvellesRetenues++;
      }
      dues.push(carteDue(nodeId, node.title, c, etat, nouvelle));
    }

    // Les plus en retard d'abord à l'intérieur d'un nœud.
    dues.sort((a, b) => a.etat.due.localeCompare(b.etat.due));
    if (dues.length > 0) parNoeud.push(dues);
  }

  return tourniquet(parNoeud);
}

function carteDue(
  nodeId: string,
  nodeTitle: string,
  c: Card,
  etat: EtatCarte,
  nouvelle: boolean,
): CarteDue {
  return {
    cardKey: cardKey(nodeId, c.id),
    nodeId,
    cardId: c.id,
    nodeTitle,
    ref: c.ref,
    front: c.front,
    back: c.back,
    etat,
    nouvelle,
  };
}

/** Prend une carte dans chaque nœud à tour de rôle, jusqu'à épuisement. */
function tourniquet(groupes: CarteDue[][]): CarteDue[] {
  const out: CarteDue[] = [];
  const max = Math.max(0, ...groupes.map((g) => g.length));
  for (let i = 0; i < max; i++) {
    for (const g of groupes) if (i < g.length) out.push(g[i]);
  }
  return out;
}

/** Compteurs pour l'en-tête : combien de cartes dues, dont neuves. */
export function compteursRevision(
  graph: Graph,
  donnees: DonneesMaths,
  maintenant: Date,
) {
  const file = fileDeRevision(graph, donnees, maintenant);
  return {
    total: file.length,
    nouvelles: file.filter((c) => c.nouvelle).length,
  };
}
