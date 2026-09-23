"use server";

import { revalidatePath } from "next/cache";
import {
  addAttempt,
  addSession,
  reviewStateOf,
  saveReview,
  setCourseRead,
  setManual,
} from "@/server/maths/data";
import { loadGraph } from "@/lib/maths/graph/load";
import { cardKey, exerciseKey } from "@/lib/maths/content";
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
