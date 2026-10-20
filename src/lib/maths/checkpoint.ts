import type { Question } from "@/lib/maths/content";

/**
 * Correction d'un checkpoint de capsule (décision D26). Pure, et appelée
 * côté serveur uniquement : les réponses attendues ne partent jamais dans le
 * navigateur, et terminer une capsule recorrige tout.
 */

/** Une réponse telle qu'envoyée par le formulaire : indice, booléen ou texte. */
export type Reponse = number | boolean | string | null;

/**
 * Lit un nombre écrit à la française ou à l'anglaise : « 0,5 », « 0.5 »,
 * « 1 000 001 », « 1e-3 ». Null si ce n'est pas un nombre.
 */
export function lireNombre(texte: string): number | null {
  const t = texte.trim().replace(/[\s  ]/g, "").replace(",", ".");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function estJuste(q: Question, r: Reponse): boolean {
  switch (q.type) {
    case "qcm":
      return typeof r === "number" && r === q.reponse;
    case "vrai-faux":
      return typeof r === "boolean" && r === q.reponse;
    case "nombre": {
      const n = typeof r === "number" ? r : typeof r === "string" ? lireNombre(r) : null;
      // Une marge relative infime absorbe l'arrondi des flottants (0,1 + 0,2).
      return n !== null && Math.abs(n - q.reponse) <= q.tolerance + 1e-9 * Math.max(1, Math.abs(q.reponse));
    }
  }
}

export function corriger(
  questions: readonly Question[],
  reponses: readonly Reponse[],
): { justes: boolean[]; tout: boolean } {
  const justes = questions.map((q, i) => estJuste(q, reponses[i] ?? null));
  return { justes, tout: justes.every(Boolean) };
}

/**
 * Ordre d'affichage des choix d'un qcm : une permutation fixe, tirée de la
 * graine (capsule et numéro de question). En rédigeant, on met la bonne
 * réponse où l'on veut — souvent au même endroit, par habitude ; l'affichage
 * la déplace, toujours de la même façon pour une question donnée.
 *
 * `ordre[d]` est l'indice, dans le fichier, du choix affiché en position d.
 */
export function ordreChoix(n: number, graine: string): number[] {
  // FNV-1a pour la graine, puis mulberry32 pour Fisher-Yates.
  let h = 0x811c9dc5;
  for (let i = 0; i < graine.length; i++) {
    h ^= graine.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  const alea = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const ordre = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(alea() * (i + 1));
    [ordre[i], ordre[j]] = [ordre[j], ordre[i]];
  }
  return ordre;
}

/** Graine de la question i d'une capsule. */
export const graineQuestion = (nodeId: string, moduleId: string, i: number) =>
  `${nodeId}/${moduleId}/${i}`;

/**
 * Réponses du formulaire, où un qcm donne la position affichée, ramenées aux
 * indices du fichier. Tout ce qui n'a pas la forme attendue devient null.
 */
export function versFichier(
  questions: readonly Question[],
  reponses: readonly unknown[],
  graine: (i: number) => string,
): Reponse[] {
  return questions.map((q, i) => {
    const r = reponses[i];
    if (q.type === "qcm") {
      if (typeof r !== "number" || !Number.isInteger(r)) return null;
      return ordreChoix(q.choix.length, graine(i))[r] ?? null;
    }
    if (q.type === "vrai-faux") return typeof r === "boolean" ? r : null;
    return typeof r === "string" || typeof r === "number" ? r : null;
  });
}
