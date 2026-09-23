import "server-only";
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

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

export type SessionLogRow = {
  id: number;
  nodeId: string;
  minutes: number;
  note: string;
  createdAt: string;
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
};

export type DonneesMaths = {
  progress: Map<string, NodeProgressRow>;
  /** Du plus récent au plus ancien. */
  sessions: SessionLogRow[];
  reviewStates: Map<string, ReviewStateRow>;
  /** Du plus récent au plus ancien. */
  attempts: AttemptRow[];
};

async function userClient() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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
type RawSession = { id: number; node_id: string; minutes: number; note: string; created_at: string };
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
};

/** Tout l'état de l'utilisateur courant, lu une seule fois par requête. */
export const chargerDonnees = cache(async (): Promise<DonneesMaths> => {
  const { supabase, user } = await userClient();
  const [p, s, r, a] = await Promise.all([
    toutes<RawProgress>(
      supabase,
      "maths_node_progress",
      "node_id, manual, course_read, mastered_at, updated_at",
      user.id,
      { column: "node_id", ascending: true },
    ),
    toutes<RawSession>(
      supabase,
      "maths_session_log",
      "id, node_id, minutes, note, created_at",
      user.id,
      { column: "id", ascending: false },
    ),
    toutes<RawReview>(
      supabase,
      "maths_review_state",
      "card_key, node_id, card_id, stability, difficulty, due, last_review, reps, lapses",
      user.id,
      { column: "card_key", ascending: true },
    ),
    toutes<RawAttempt>(
      supabase,
      "maths_attempt",
      "id, exercise_key, node_id, difficulty, outcome, minutes_spent, note, created_at",
      user.id,
      { column: "id", ascending: false },
    ),
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
    })),
    reviewStates: new Map(
      r.map((x) => [
        x.card_key,
        {
          cardKey: x.card_key,
          nodeId: x.node_id,
          cardId: x.card_id,
          stability: Number(x.stability),
          difficulty: Number(x.difficulty),
          due: x.due,
          lastReview: x.last_review,
          reps: x.reps,
          lapses: x.lapses,
        },
      ]),
    ),
    attempts: a.map((x) => ({
      id: x.id,
      exerciseKey: x.exercise_key,
      nodeId: x.node_id,
      difficulty: x.difficulty,
      outcome: x.outcome,
      minutesSpent: x.minutes_spent,
      note: x.note,
      createdAt: x.created_at,
    })),
  };
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

export async function setManual(nodeId: string, manual: Manual) {
  const { supabase } = await userClient();
  const { error } = await supabase.rpc("maths_set_manual", {
    p_node_id: nodeId,
    p_manual: manual,
  });
  if (error) throw error;
}

export async function setCourseRead(nodeId: string, read: boolean) {
  const { supabase, user } = await userClient();
  const { error } = await supabase
    .from("maths_node_progress")
    .upsert(
      { user_id: user.id, node_id: nodeId, course_read: read },
      { onConflict: "user_id,node_id" },
    );
  if (error) throw error;
}

export async function addSession(nodeId: string, minutes: number, note: string) {
  const { supabase, user } = await userClient();
  const { error } = await supabase
    .from("maths_session_log")
    .insert({ user_id: user.id, node_id: nodeId, minutes, note });
  if (error) throw error;
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
  if (!data) return null;
  const x = data as RawReview;
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

export async function addAttempt(row: {
  exerciseKey: string;
  nodeId: string;
  difficulty: number;
  outcome: Outcome;
  minutesSpent: number;
  note: string;
}) {
  const { supabase, user } = await userClient();
  const { error } = await supabase.from("maths_attempt").insert({
    user_id: user.id,
    exercise_key: row.exerciseKey,
    node_id: row.nodeId,
    difficulty: row.difficulty,
    outcome: row.outcome,
    minutes_spent: row.minutesSpent,
    note: row.note,
  });
  if (error) throw error;
}
