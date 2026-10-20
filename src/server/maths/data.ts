import "server-only";
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, userFromClaims } from "@/lib/supabase/server";

/**
 * État mutable du parcours /maths, par utilisateur, dans Supabase.
 *
 * L'ancienne application lisait SQLite de façon synchrone, table par table,
 * au fil du rendu. Ici tout l'état d'un utilisateur est lu **une fois par
 * requête** (`chargerDonnees`, mémoïsé par `cache`) puis interrogé en mémoire :
 * quelques milliers de lignes au plus, et un seul aller-retour au lieu d'une
 * dizaine par page. Les fonctions de lecture ci-dessous sont donc pures.
 */

export type Manual = "none" | "in-progress" | "learned" | "mastered";
export type Outcome = "resolu-seul" | "resolu-avec-indice" | "echec" | "abandonne";

export type NodeProgressRow = {
  nodeId: string;
  manual: Manual;
  courseRead: boolean;
  masteredAt: string | null;
  updatedAt: string;
};

/** Qui a saisi une ligne (migration 0028). Absent des lectures du navigateur. */
export type Author = "arthur" | "claude";

export type SessionLogRow = {
  id: number;
  nodeId: string;
  minutes: number;
  note: string;
  createdAt: string;
  createdBy?: Author;
};

export type ReviewStateRow = {
  cardKey: string;
  nodeId: string;
  cardId: string;
  stability: number;
  difficulty: number;
  /** Date ISO, granularité jour. */
  due: string;
  lastReview: string | null;
  reps: number;
  lapses: number;
};

export type AttemptRow = {
  id: number;
  exerciseKey: string;
  nodeId: string;
  difficulty: number;
  outcome: Outcome;
  minutesSpent: number;
  note: string;
  createdAt: string;
  createdBy?: Author;
};

export type DonneesMaths = {
  progress: Map<string, NodeProgressRow>;
  /** Capsules terminées (migration 0029), par nœud : nodeId → ids. */
  modules: Map<string, Set<string>>;
  /** Du plus récent au plus ancien. */
  sessions: SessionLogRow[];
  reviewStates: Map<string, ReviewStateRow>;
  /** Du plus récent au plus ancien. */
  attempts: AttemptRow[];
};

async function userClient() {
  const supabase = await createClient();
  const user = await userFromClaims(supabase);
  if (!user) throw new Error("Not authenticated");
  return { supabase, user };
}

/**
 * PostgREST plafonne une réponse à 1000 lignes par défaut. Les tentatives et
 * les états de cartes dépasseront ce plafond en quelques mois : on pagine
 * plutôt que de découvrir un jour des données silencieusement tronquées.
 */
const PAGE = 1000;

async function toutes<T>(
  supabase: SupabaseClient,
  table: string,
  select: string,
  userId: string,
  order?: { column: string; ascending: boolean },
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(select).eq("user_id", userId);
    if (order) q = q.order(order.column, { ascending: order.ascending });
    // Ordre total et stable pour que les pages ne se chevauchent pas.
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

type RawProgress = {
  node_id: string;
  manual: Manual;
  course_read: boolean;
  mastered_at: string | null;
  updated_at: string;
};
type RawModule = { node_id: string; module_id: string; completed_at: string };
type RawSession = { id: number; node_id: string; minutes: number; note: string; created_at: string; created_by?: Author };
type RawReview = {
  card_key: string;
  node_id: string;
  card_id: string;
  stability: number;
  difficulty: number;
  due: string;
  last_review: string | null;
  reps: number;
  lapses: number;
};
type RawAttempt = {
  id: number;
  exercise_key: string;
  node_id: string;
  difficulty: number;
  outcome: Outcome;
  minutes_spent: number;
  note: string;
  created_at: string;
  created_by?: Author;
};

/**
 * Tout l'état d'un utilisateur, avec le client donné : la session du navigateur
 * ou le jeton du connecteur Claude (RLS dans les deux cas).
 *
 * `auteur` ajoute `created_by` aux sessions et tentatives. Le navigateur ne le
 * demande pas : ses pages n'en ont pas besoin et ne dépendent ainsi pas de la
 * migration 0028.
 */
export async function chargerDonneesDe(
  supabase: SupabaseClient,
  userId: string,
  { auteur = false }: { auteur?: boolean } = {},
): Promise<DonneesMaths> {
  const qui = auteur ? ", created_by" : "";
  const [p, s, r, a, m] = await Promise.all([
    toutes<RawProgress>(
      supabase,
      "maths_node_progress",
      "node_id, manual, course_read, mastered_at, updated_at",
      userId,
      { column: "node_id", ascending: true },
    ),
    toutes<RawSession>(
      supabase,
      "maths_session_log",
      `id, node_id, minutes, note, created_at${qui}`,
      userId,
      { column: "id", ascending: false },
    ),
    toutes<RawReview>(
      supabase,
      "maths_review_state",
      "card_key, node_id, card_id, stability, difficulty, due, last_review, reps, lapses",
      userId,
      { column: "card_key", ascending: true },
    ),
    toutes<RawAttempt>(
      supabase,
      "maths_attempt",
      `id, exercise_key, node_id, difficulty, outcome, minutes_spent, note, created_at${qui}`,
      userId,
      { column: "id", ascending: false },
    ),
    capsulesTerminees(supabase, userId),
  ]);

  return {
    progress: new Map(
      p.map((x) => [
        x.node_id,
        {
          nodeId: x.node_id,
          manual: x.manual,
          courseRead: x.course_read,
          masteredAt: x.mastered_at,
          updatedAt: x.updated_at,
        },
      ]),
    ),
    sessions: s.map((x) => ({
      id: x.id,
      nodeId: x.node_id,
      minutes: x.minutes,
      note: x.note,
      createdAt: x.created_at,
      ...(x.created_by ? { createdBy: x.created_by } : {}),
    })),
    modules: parNoeud(m),
    reviewStates: new Map(r.map((x) => [x.card_key, reviewRow(x)])),
    attempts: a.map((x) => ({
      id: x.id,
      exerciseKey: x.exercise_key,
      nodeId: x.node_id,
      difficulty: x.difficulty,
      outcome: x.outcome,
      minutesSpent: x.minutes_spent,
      note: x.note,
      createdAt: x.created_at,
      ...(x.created_by ? { createdBy: x.created_by } : {}),
    })),
  };
}

/**
 * Capsules terminées. Lues de façon tolérante : tant que la migration 0029
 * n'est pas appliquée, la table n'existe pas et toutes les pages du parcours
 * planteraient pour une information secondaire. Une table absente vaut donc
 * « aucune capsule terminée » ; toute autre erreur remonte.
 */
async function capsulesTerminees(
  supabase: SupabaseClient,
  userId: string,
): Promise<RawModule[]> {
  try {
    return await toutes<RawModule>(
      supabase,
      "maths_module_progress",
      "node_id, module_id, completed_at",
      userId,
      { column: "completed_at", ascending: true },
    );
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "42P01" || code === "PGRST205") return [];
    throw e;
  }
}

function parNoeud(rows: RawModule[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const x of rows) {
    const set = out.get(x.node_id) ?? new Set<string>();
    set.add(x.module_id);
    out.set(x.node_id, set);
  }
  return out;
}

function reviewRow(x: RawReview): ReviewStateRow {
  return {
    cardKey: x.card_key,
    nodeId: x.node_id,
    cardId: x.card_id,
    stability: Number(x.stability),
    difficulty: Number(x.difficulty),
    due: x.due,
    lastReview: x.last_review,
    reps: x.reps,
    lapses: x.lapses,
  };
}

/** Tout l'état de l'utilisateur courant, lu une seule fois par requête. */
export const chargerDonnees = cache(async (): Promise<DonneesMaths> => {
  const { supabase, user } = await userClient();
  return chargerDonneesDe(supabase, user.id);
});

// ── Lectures (pures, sur l'instantané) ─────────────────────────────────────

/**
 * Marquages manuels, par nœud. Les preuves complètes — tentatives d'exercices
 * et stabilités FSRS — sont assemblées dans lib/maths/progression/evidence.ts,
 * qui a besoin du contenu en plus de la base.
 */
export function marquagesManuels(
  d: DonneesMaths,
): Map<string, { manual: Manual; courseRead: boolean }> {
  return new Map(
    [...d.progress.values()].map((r) => [
      r.nodeId,
      { manual: r.manual, courseRead: r.courseRead },
    ]),
  );
}

export function progressOf(d: DonneesMaths, nodeId: string): NodeProgressRow | null {
  return d.progress.get(nodeId) ?? null;
}

/** Ids des capsules terminées d'un nœud. */
export function capsulesTermineesDe(d: DonneesMaths, nodeId: string): Set<string> {
  return d.modules.get(nodeId) ?? new Set();
}

export function sessionsOf(d: DonneesMaths, nodeId: string): SessionLogRow[] {
  return d.sessions.filter((s) => s.nodeId === nodeId);
}

export function reviewStatesOfNode(d: DonneesMaths, nodeId: string): ReviewStateRow[] {
  return [...d.reviewStates.values()].filter((r) => r.nodeId === nodeId);
}

export function attemptsOfNode(d: DonneesMaths, nodeId: string): AttemptRow[] {
  return d.attempts.filter((a) => a.nodeId === nodeId);
}

/**
 * Minutes cumulées par nœud : journal de session **et** temps déclaré sur les
 * tentatives d'exercices. Les deux comptent comme du temps passé sur le nœud,
 * et n'en additionner qu'un donnerait un temps réel systématiquement sous-évalué.
 */
export function minutesByNode(d: DonneesMaths): Map<string, number> {
  const total = new Map<string, number>();
  const ajoute = (nodeId: string, m: number) =>
    total.set(nodeId, (total.get(nodeId) ?? 0) + m);
  for (const s of d.sessions) ajoute(s.nodeId, s.minutes);
  for (const a of d.attempts) ajoute(a.nodeId, a.minutesSpent);
  return total;
}

// ── Écritures ───────────────────────────────────────────────────────────────
//
// Chaque écriture existe en deux formes : `…Avec(supabase, userId, …)`, qui
// prend le client explicitement (le connecteur Claude), et la forme courte,
// qui prend la session du navigateur.

export async function setManualAvec(supabase: SupabaseClient, nodeId: string, manual: Manual) {
  const { error } = await supabase.rpc("maths_set_manual", {
    p_node_id: nodeId,
    p_manual: manual,
  });
  if (error) throw error;
}

export async function setManual(nodeId: string, manual: Manual) {
  const { supabase } = await userClient();
  await setManualAvec(supabase, nodeId, manual);
}

export async function setCourseReadAvec(
  supabase: SupabaseClient,
  userId: string,
  nodeId: string,
  read: boolean,
) {
  const { error } = await supabase
    .from("maths_node_progress")
    .upsert(
      { user_id: userId, node_id: nodeId, course_read: read },
      { onConflict: "user_id,node_id" },
    );
  if (error) throw error;
}

export async function setCourseRead(nodeId: string, read: boolean) {
  const { supabase, user } = await userClient();
  await setCourseReadAvec(supabase, user.id, nodeId, read);
}

/**
 * Marque une capsule terminée, ou la rouvre. Idempotent dans les deux sens :
 * terminer deux fois garde la première date, rouvrir une capsule non
 * terminée ne fait rien.
 */
export async function setModuleDoneAvec(
  supabase: SupabaseClient,
  userId: string,
  nodeId: string,
  moduleId: string,
  done: boolean,
) {
  const { error } = done
    ? await supabase
        .from("maths_module_progress")
        .upsert(
          { user_id: userId, node_id: nodeId, module_id: moduleId },
          { onConflict: "user_id,node_id,module_id", ignoreDuplicates: true },
        )
    : await supabase
        .from("maths_module_progress")
        .delete()
        .eq("user_id", userId)
        .eq("node_id", nodeId)
        .eq("module_id", moduleId);
  if (error) throw error;
}

/** Capsules terminées d'un nœud, relues juste après une écriture. */
export async function modulesDoneOf(nodeId: string): Promise<Set<string>> {
  const { supabase, user } = await userClient();
  const { data, error } = await supabase
    .from("maths_module_progress")
    .select("module_id")
    .eq("user_id", user.id)
    .eq("node_id", nodeId);
  if (error) throw error;
  return new Set((data ?? []).map((x: { module_id: string }) => x.module_id));
}

export async function setModuleDone(nodeId: string, moduleId: string, done: boolean) {
  const { supabase, user } = await userClient();
  await setModuleDoneAvec(supabase, user.id, nodeId, moduleId, done);
}

/** Ajoute une ligne au journal de session ; renvoie son id. */
export async function addSessionAvec(
  supabase: SupabaseClient,
  userId: string,
  nodeId: string,
  minutes: number,
  note: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("maths_session_log")
    .insert({ user_id: userId, node_id: nodeId, minutes, note })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: number }).id;
}

export async function addSession(nodeId: string, minutes: number, note: string) {
  const { supabase, user } = await userClient();
  await addSessionAvec(supabase, user.id, nodeId, minutes, note);
}

/** Enregistre une révision : nouvel état de la carte, et trace dans le journal. */
export async function saveReview(args: {
  cardKey: string;
  nodeId: string;
  cardId: string;
  rating: number;
  elapsedDays: number;
  avant: { stability: number; difficulty: number };
  apres: {
    stability: number;
    difficulty: number;
    due: string;
    lastReview: string | null;
    reps: number;
    lapses: number;
  };
}) {
  const { supabase } = await userClient();
  const { error } = await supabase.rpc("maths_save_review", {
    p_card_key: args.cardKey,
    p_node_id: args.nodeId,
    p_card_id: args.cardId,
    p_rating: args.rating,
    p_elapsed_days: args.elapsedDays,
    p_stability_before: args.avant.stability,
    p_difficulty_before: args.avant.difficulty,
    p_stability: args.apres.stability,
    p_difficulty: args.apres.difficulty,
    p_due: args.apres.due,
    p_last_review: args.apres.lastReview,
    p_reps: args.apres.reps,
    p_lapses: args.apres.lapses,
  });
  if (error) throw error;
}

/** État FSRS d'une seule carte, relu juste avant d'être recalculé. */
export async function reviewStateOf(cardKey: string): Promise<ReviewStateRow | null> {
  const { supabase, user } = await userClient();
  const { data, error } = await supabase
    .from("maths_review_state")
    .select("card_key, node_id, card_id, stability, difficulty, due, last_review, reps, lapses")
    .eq("user_id", user.id)
    .eq("card_key", cardKey)
    .maybeSingle();
  if (error) throw error;
  return data ? reviewRow(data as RawReview) : null;
}

export type AttemptInput = {
  exerciseKey: string;
  nodeId: string;
  difficulty: number;
  outcome: Outcome;
  minutesSpent: number;
  note: string;
};

/** Enregistre une tentative ; renvoie son id. */
export async function addAttemptAvec(
  supabase: SupabaseClient,
  userId: string,
  row: AttemptInput,
): Promise<number> {
  const { data, error } = await supabase
    .from("maths_attempt")
    .insert({
      user_id: userId,
      exercise_key: row.exerciseKey,
      node_id: row.nodeId,
      difficulty: row.difficulty,
      outcome: row.outcome,
      minutes_spent: row.minutesSpent,
      note: row.note,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: number }).id;
}

export async function addAttempt(row: AttemptInput) {
  const { supabase, user } = await userClient();
  await addAttemptAvec(supabase, user.id, row);
}

/**
 * Modifie une tentative ou une session. Renvoie false si aucune ligne n'a été
 * touchée : inexistante, ou — pour le connecteur — saisie par Arthur (0028).
 */
export async function updateAttemptAvec(
  supabase: SupabaseClient,
  userId: string,
  id: number,
  patch: { outcome?: Outcome; minutesSpent?: number; note?: string },
): Promise<boolean> {
  const row: Record<string, unknown> = {};
  if (patch.outcome !== undefined) row.outcome = patch.outcome;
  if (patch.minutesSpent !== undefined) row.minutes_spent = patch.minutesSpent;
  if (patch.note !== undefined) row.note = patch.note;
  const { data, error } = await supabase
    .from("maths_attempt")
    .update(row)
    .eq("user_id", userId)
    .eq("id", id)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export async function updateSessionAvec(
  supabase: SupabaseClient,
  userId: string,
  id: number,
  patch: { minutes?: number; note?: string },
): Promise<boolean> {
  const row: Record<string, unknown> = {};
  if (patch.minutes !== undefined) row.minutes = patch.minutes;
  if (patch.note !== undefined) row.note = patch.note;
  const { data, error } = await supabase
    .from("maths_session_log")
    .update(row)
    .eq("user_id", userId)
    .eq("id", id)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export async function deleteEntryAvec(
  supabase: SupabaseClient,
  userId: string,
  table: "maths_attempt" | "maths_session_log",
  id: number,
): Promise<boolean> {
  const { data, error } = await supabase
    .from(table)
    .delete()
    .eq("user_id", userId)
    .eq("id", id)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export type ReviewLogRow = {
  cardKey: string;
  nodeId: string;
  rating: 1 | 2 | 3 | 4;
  elapsedDays: number;
  stabilityBefore: number;
  stabilityAfter: number;
  reviewedAt: string;
};

/** Journal des révisions, du plus récent au plus ancien. */
export async function reviewLogAvec(
  supabase: SupabaseClient,
  userId: string,
  { nodeId, since, limit }: { nodeId?: string; since?: string; limit: number },
): Promise<ReviewLogRow[]> {
  let q = supabase
    .from("maths_review_log")
    .select("card_key, node_id, rating, elapsed_days, stability_before, stability_after, reviewed_at")
    .eq("user_id", userId);
  if (nodeId) q = q.eq("node_id", nodeId);
  if (since) q = q.gte("reviewed_at", since);
  const { data, error } = await q.order("id", { ascending: false }).limit(limit);
  if (error) throw error;
  return (
    (data ?? []) as {
      card_key: string;
      node_id: string;
      rating: 1 | 2 | 3 | 4;
      elapsed_days: number;
      stability_before: number;
      stability_after: number;
      reviewed_at: string;
    }[]
  ).map((x) => ({
    cardKey: x.card_key,
    nodeId: x.node_id,
    rating: x.rating,
    elapsedDays: Number(x.elapsed_days),
    stabilityBefore: Number(x.stability_before),
    stabilityAfter: Number(x.stability_after),
    reviewedAt: x.reviewed_at,
  }));
}
