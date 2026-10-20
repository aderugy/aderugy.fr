"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addAttempt,
  addSession,
  modulesDoneOf,
  reviewStateOf,
  saveReview,
  setCourseRead,
  setManual,
  setModuleDone,
} from "@/server/maths/data";
import { loadGraph } from "@/lib/maths/graph/load";
import { cardKey, exerciseKey, loadExercises, loadModules } from "@/lib/maths/content";
import { coursTermine, voisine } from "@/lib/maths/progression/capsules";
import { corriger, graineQuestion, versFichier } from "@/lib/maths/checkpoint";
import { BAREME } from "@/lib/maths/jeu";
import { compiler } from "@/lib/maths/mdx";
import { createClient, userFromClaims } from "@/lib/supabase/server";
import {
  carteNeuve,
  joursEcoules,
  reviser,
  type EtatCarte,
  type Note,
} from "@/lib/maths/fsrs";

function assertConcept(nodeId: string) {
  const node = loadGraph().byId.get(nodeId);
  if (!node || node.kind !== "concept")
    throw new Error(`nœud inconnu ou non évaluable : ${nodeId}`);
}

export async function marquerEtat(nodeId: string, formData: FormData) {
  assertConcept(nodeId);
  const manual = String(formData.get("manual"));
  if (!["none", "in-progress", "learned", "mastered"].includes(manual))
    throw new Error(`état invalide : ${manual}`);
  await setManual(nodeId, manual as "none" | "in-progress" | "learned" | "mastered");
  revalidatePath(`/maths/n/${nodeId}`);
  revalidatePath("/maths");
}

export async function marquerCoursLu(nodeId: string, formData: FormData) {
  assertConcept(nodeId);
  await setCourseRead(nodeId, formData.get("read") === "1");
  revalidatePath(`/maths/n/${nodeId}`);
  revalidatePath("/maths");
}

/**
 * Termine une capsule, puis enchaîne sur la suivante — ou revient au nœud
 * après la dernière. Terminer la dernière capsule non lue marque le cours
 * comme lu : c'est la seule preuve de lecture que lisent les règles de
 * progression, et elle reste acquise si l'on rouvre ensuite une capsule.
 */
export async function terminerCapsule(nodeId: string, moduleId: string) {
  const { capsules, capsule } = capsuleDe(nodeId, moduleId);
  // Une capsule à checkpoint ne se termine qu'en le réussissant (D26).
  if (capsule.checkpoint.length > 0)
    throw new Error(`la capsule ${moduleId} se termine en réussissant son checkpoint`);
  await finir(nodeId, moduleId, capsules, null);
}

/**
 * Corrige un checkpoint sans rien enregistrer. Renvoie, pour chaque question,
 * si elle est juste, et l'explication des seules questions justes : une
 * réponse fausse n'apprend pas la bonne, on peut réessayer.
 */
export async function corrigerCheckpoint(
  nodeId: string,
  moduleId: string,
  reponses: unknown[],
) {
  const user = await userFromClaims(await createClient());
  if (!user) throw new Error("Not authenticated");
  const { capsule } = capsuleDe(nodeId, moduleId);
  const questions = capsule.checkpoint;
  const { justes, tout } = corriger(
    questions,
    versFichier(questions, Array.isArray(reponses) ? reponses : [], (i) =>
      graineQuestion(nodeId, moduleId, i),
    ),
  );
  const explications = await Promise.all(
    questions.map((q, i) => (justes[i] ? compiler(q.explication) : null)),
  );
  return { justes, tout, explications };
}

/**
 * Termine une capsule à checkpoint. Les réponses sont recorrigées ici : rien
 * de ce que le navigateur affirme n'est cru, sauf le nombre d'essais, qui ne
 * sert qu'au bonus du premier essai.
 */
export async function validerCapsule(
  nodeId: string,
  moduleId: string,
  reponses: unknown[],
  essais: number,
) {
  const { capsules, capsule } = capsuleDe(nodeId, moduleId);
  const questions = capsule.checkpoint;
  const { tout } = corriger(
    questions,
    versFichier(questions, Array.isArray(reponses) ? reponses : [], (i) =>
      graineQuestion(nodeId, moduleId, i),
    ),
  );
  if (!tout) throw new Error("checkpoint non réussi");
  const n = Number.isFinite(essais) ? Math.min(99, Math.max(1, Math.round(essais))) : 1;
  await finir(nodeId, moduleId, capsules, questions.length > 0 ? n : null);
}

async function finir(
  nodeId: string,
  moduleId: string,
  capsules: { id: string }[],
  essais: number | null,
) {
  await setModuleDone(nodeId, moduleId, true, essais);
  if (coursTermine(capsules, await modulesDoneOf(nodeId)))
    await setCourseRead(nodeId, true);
  revalidatePath(`/maths/n/${nodeId}`);
  revalidatePath(`/maths/n/${nodeId}/m/${moduleId}`);
  revalidatePath("/maths");
  // Le gain est annoncé sur la page suivante (`?gagne=`), à titre
  // d'information seulement : l'XP réelle est toujours recalculée.
  const gagne = BAREME.capsule + (essais === 1 ? BAREME.premierEssai : 0);
  const suivante = voisine(capsules, moduleId, 1);
  redirect(
    suivante
      ? `/maths/n/${nodeId}/m/${suivante}?gagne=${gagne}`
      : `/maths/n/${nodeId}?gagne=${gagne}`,
  );
}

/** Rouvre une capsule terminée, pour la relire comme neuve. */
export async function rouvrirCapsule(nodeId: string, moduleId: string) {
  capsuleDe(nodeId, moduleId);
  await setModuleDone(nodeId, moduleId, false);
  revalidatePath(`/maths/n/${nodeId}`);
  revalidatePath(`/maths/n/${nodeId}/m/${moduleId}`);
  revalidatePath("/maths");
}

function capsuleDe(nodeId: string, moduleId: string) {
  assertConcept(nodeId);
  const capsules = loadModules(loadGraph().byId.get(nodeId)!);
  const capsule = capsules.find((c) => c.id === moduleId);
  if (!capsule) throw new Error(`capsule inconnue : ${nodeId}/${moduleId}`);
  return { capsules, capsule };
}

export async function ajouterSession(nodeId: string, formData: FormData) {
  assertConcept(nodeId);
  const minutes = Number(formData.get("minutes"));
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60)
    throw new Error("durée invalide");
  await addSession(nodeId, Math.round(minutes), String(formData.get("note") ?? ""));
  revalidatePath(`/maths/n/${nodeId}`);
  revalidatePath("/maths");
}

// ── Révision ────────────────────────────────────────────────────────────────

/**
 * Enregistre une note de révision. L'état FSRS est relu en base juste avant
 * d'être recalculé : deux onglets ouverts sur la même carte ne peuvent pas
 * produire d'état incohérent, le dernier passage gagne.
 */
export async function noterCarte(
  cardKeyValue: string,
  nodeId: string,
  cardId: string,
  rating: number,
) {
  if (![1, 2, 3, 4].includes(rating)) throw new Error(`note invalide ${rating}`);
  assertConcept(nodeId);
  if (cardKeyValue !== cardKey(nodeId, cardId))
    throw new Error(`carte incohérente : ${cardKeyValue}`);
  const maintenant = new Date();
  const row = await reviewStateOf(cardKeyValue);
  const avant: EtatCarte = row
    ? {
        stability: row.stability,
        difficulty: row.difficulty,
        due: row.due,
        lastReview: row.lastReview,
        reps: row.reps,
        lapses: row.lapses,
      }
    : carteNeuve(maintenant);

  const apres = reviser(avant, rating as Note, maintenant);

  await saveReview({
    cardKey: cardKeyValue,
    nodeId,
    cardId,
    rating,
    elapsedDays: joursEcoules(avant.lastReview, maintenant),
    avant: { stability: avant.stability, difficulty: avant.difficulty },
    apres,
  });

  revalidatePath("/maths/revision");
  revalidatePath(`/maths/n/${nodeId}`);
  revalidatePath("/maths");
  return { stability: apres.stability, due: apres.due };
}

// ── Tentatives d'exercices ──────────────────────────────────────────────────

export async function enregistrerTentative(
  nodeId: string,
  exerciseId: string,
  difficulty: number,
  formData: FormData,
) {
  assertConcept(nodeId);
  const outcome = String(formData.get("outcome"));
  const valides = ["resolu-seul", "resolu-avec-indice", "echec", "abandonne"];
  if (!valides.includes(outcome)) throw new Error(`issue invalide ${outcome}`);
  const minutes = Number(formData.get("minutes") ?? 0);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60)
    throw new Error("durée invalide");

  await addAttempt({
    exerciseKey: exerciseKey(nodeId, exerciseId),
    nodeId,
    difficulty,
    outcome: outcome as
      | "resolu-seul"
      | "resolu-avec-indice"
      | "echec"
      | "abandonne",
    minutesSpent: Math.round(minutes),
    note: String(formData.get("note") ?? ""),
  });

  revalidatePath(`/maths/n/${nodeId}`);
  revalidatePath("/maths");
}

/**
 * Énoncé, indices et correction d'un exercice, rendus à la demande.
 *
 * La page de nœud ne les embarque plus : ils sont repliés à l'affichage, et
 * les envoyer tous gonflait la charge de la page de plus de moitié pour du
 * contenu que l'on n'ouvre qu'un exercice à la fois. Le rendu sort du cache
 * de compilation (lib/maths/mdx), donc l'appel coûte un aller-retour, pas
 * une compilation.
 */
export async function contenuExercice(nodeId: string, exerciseId: string) {
  const user = await userFromClaims(await createClient());
  if (!user) throw new Error("Not authenticated");
  assertConcept(nodeId);
  const exercice = loadExercises(loadGraph().byId.get(nodeId)!).find(
    (e) => e.id === exerciseId,
  );
  if (!exercice) throw new Error(`exercice inconnu : ${nodeId}/${exerciseId}`);
  const [statement, solution, ...hints] = await Promise.all([
    compiler(exercice.statement),
    compiler(exercice.solution),
    ...exercice.hints.map(compiler),
  ]);
  return { statement, hints, solution };
}
