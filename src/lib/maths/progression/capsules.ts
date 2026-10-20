/**
 * Avancement dans les capsules d'un nœud (décision D25). Pur : les pages, les
 * actions et le connecteur passent l'ensemble des capsules terminées lu en
 * base, et le contenu lu sur disque.
 *
 * Les capsules ne se verrouillent pas entre elles : le parcours en propose
 * une, la suivante non terminée, mais on peut toujours en ouvrir une autre —
 * relire une démonstration ou sauter ce qu'on sait déjà ne doit rien coûter.
 */

export type EtatCapsule = "terminee" | "prochaine" | "a-lire";

export type Avancement = {
  total: number;
  terminees: number;
  /** Première capsule non terminée, dans l'ordre ; null si tout est lu. */
  prochaine: string | null;
  etats: Map<string, EtatCapsule>;
};

export function avancementCapsules(
  capsules: readonly { id: string }[],
  terminees: ReadonlySet<string>,
): Avancement {
  const etats = new Map<string, EtatCapsule>();
  let prochaine: string | null = null;
  let n = 0;
  for (const c of capsules) {
    if (terminees.has(c.id)) {
      etats.set(c.id, "terminee");
      n++;
    } else if (prochaine === null) {
      prochaine = c.id;
      etats.set(c.id, "prochaine");
    } else {
      etats.set(c.id, "a-lire");
    }
  }
  return { total: capsules.length, terminees: n, prochaine, etats };
}

/**
 * Toutes les capsules du nœud sont terminées : le cours compte comme lu. Un
 * nœud sans capsule n'est jamais « lu » par ce biais — il garde le marquage
 * manuel de la V0.
 */
export function coursTermine(
  capsules: readonly { id: string }[],
  terminees: ReadonlySet<string>,
): boolean {
  return capsules.length > 0 && capsules.every((c) => terminees.has(c.id));
}

/** Capsule voisine dans l'ordre du nœud, ou null en bout de parcours. */
export function voisine(
  capsules: readonly { id: string }[],
  id: string,
  sens: -1 | 1,
): string | null {
  const i = capsules.findIndex((c) => c.id === id);
  if (i === -1) return null;
  return capsules[i + sens]?.id ?? null;
}

/**
 * Exercices rangés après la capsule qui les rend faisables (`after`). Ceux
 * sans `after`, ou dont la capsule n'existe pas, vont en fin de parcours sous
 * la clé null : un exercice n'est jamais perdu par une faute de frappe, il se
 * retrouve simplement à la fin, où le validateur le signale.
 */
export function exercicesParCapsule<E extends { after: string | null }>(
  capsules: readonly { id: string }[],
  exercices: readonly E[],
): Map<string | null, E[]> {
  const ids = new Set(capsules.map((c) => c.id));
  const out = new Map<string | null, E[]>();
  for (const e of exercices) {
    const cle = e.after && ids.has(e.after) ? e.after : null;
    out.set(cle, [...(out.get(cle) ?? []), e]);
  }
  return out;
}
