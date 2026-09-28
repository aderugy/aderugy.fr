import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { PokerNode } from "@/lib/solver/types";
import { entryLabel } from "@/lib/trainer/labels";
import type { Trainer, TrainerAnswer, TrainerHand, TrainerNodeRow, TrainerSession } from "@/lib/trainer/types";

export const TRAINER_SELECT =
  "id, name, hero_seat, villain_seat, pot_bb, stack_bb, street, stop_at_street_end, feedback, archived, created_at, updated_at";
const SESSION_SELECT =
  "id, trainer_id, started_at, ended_at, hands, correct, blunders, played_hands, perfect_hands, last_answer_at";
const ANSWER_SELECT =
  "id, session_id, node_id, combo, board, actions, freqs, rng, expected_action_id, chosen_action_id, chosen_freq, grade, answered_ms, answered_at, hand_id, step, line, pot_bb";
const HAND_SELECT =
  "id, session_id, entry_node_id, end_node_id, combo, villain_combo, board, line, end_reason, decisions, correct, ended_at";

async function userClient() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  return { supabase, user };
}

export type TrainerListItem = Trainer & {
  nodeCount: number;
  sessions: number;
  lastScore: number | null;
  lastPlayed: string | null;
};

export async function listTrainers(): Promise<TrainerListItem[]> {
  const { supabase, user } = await userClient();
  const [t, n, s] = await Promise.all([
    supabase.from("poker_trainers").select(TRAINER_SELECT).eq("user_id", user.id).order("updated_at", { ascending: false }),
    supabase.from("poker_trainer_nodes").select("trainer_id").eq("user_id", user.id),
    supabase
      .from("poker_trainer_sessions")
      .select("trainer_id, started_at, hands, correct")
      .eq("user_id", user.id)
      .gt("hands", 0)
      .order("started_at", { ascending: false }),
  ]);
  if (t.error) throw t.error;
  if (n.error) throw n.error;
  if (s.error) throw s.error;

  const nodeCount = new Map<string, number>();
  for (const r of n.data ?? []) nodeCount.set(r.trainer_id, (nodeCount.get(r.trainer_id) ?? 0) + 1);
  const sessions = new Map<string, { count: number; last: { started_at: string; hands: number; correct: number } }>();
  for (const r of s.data ?? []) {
    const cur = sessions.get(r.trainer_id);
    if (cur) cur.count++;
    else sessions.set(r.trainer_id, { count: 1, last: r });
  }

  return ((t.data ?? []) as Trainer[]).map((tr) => {
    const ss = sessions.get(tr.id);
    return {
      ...tr,
      nodeCount: nodeCount.get(tr.id) ?? 0,
      sessions: ss?.count ?? 0,
      lastScore: ss ? (ss.last.correct / ss.last.hands) * 100 : null,
      lastPlayed: ss?.last.started_at ?? null,
    };
  });
}

export type TrainerNodeView = TrainerNodeRow & {
  spotName: string;
  label: string | null;
  missing: boolean;
};

export type TrainerPage = {
  trainer: Trainer;
  nodes: TrainerNodeView[];
  sessions: TrainerSession[];
  answers: TrainerAnswer[];
  hands: TrainerHand[];
  /** Nodes that answers and hands point at (decisions, where hands stopped): id → label and spot, to link to them. */
  nodeInfo: Record<string, { label: string; spotId: string; spotName: string }>;
};

/** Answers read for the history tab: the most recent ones are enough for trends and leaks. */
const HISTORY_ANSWERS = 3000;

export async function getTrainerPage(trainerId: string): Promise<TrainerPage | null> {
  const { supabase, user } = await userClient();
  const [t, n, s] = await Promise.all([
    supabase.from("poker_trainers").select(TRAINER_SELECT).eq("id", trainerId).eq("user_id", user.id).maybeSingle(),
    supabase
      .from("poker_trainer_nodes")
      .select("trainer_id, node_id, spot_id, street, board, line, hero_seat, villain_seat, weight, resolved_at, added_at")
      .eq("trainer_id", trainerId)
      .eq("user_id", user.id)
      .order("added_at"),
    supabase
      .from("poker_trainer_sessions")
      .select(SESSION_SELECT)
      .eq("trainer_id", trainerId)
      .eq("user_id", user.id)
      .order("started_at", { ascending: true }),
  ]);
  if (t.error) throw t.error;
  if (n.error) throw n.error;
  if (s.error) throw s.error;
  if (!t.data) return null;

  const rows = (n.data ?? []) as TrainerNodeRow[];
  const sessions = ((s.data ?? []) as TrainerSession[]).filter((x) => x.hands > 0 || x.ended_at === null);
  const spotIds = [...new Set(rows.map((r) => r.spot_id))];

  const [spots, nodes, answers, hands] = await Promise.all([
    spotIds.length
      ? supabase.from("poker_spots").select("id, name").eq("user_id", user.id).in("id", spotIds)
      : Promise.resolve({ data: [], error: null }),
    rows.length
      ? supabase
          .from("poker_nodes")
          .select("id, spot_id, parent_id, type, position, data, created_at, updated_at")
          .eq("user_id", user.id)
          .in("id", rows.map((r) => r.node_id))
      : Promise.resolve({ data: [], error: null }),
    sessions.length
      ? supabase
          .from("poker_trainer_answers")
          .select(ANSWER_SELECT)
          .eq("user_id", user.id)
          .in("session_id", sessions.map((x) => x.id))
          .order("answered_at", { ascending: false })
          .limit(HISTORY_ANSWERS)
      : Promise.resolve({ data: [], error: null }),
    sessions.length
      ? supabase
          .from("poker_trainer_hands")
          .select(HAND_SELECT)
          .eq("user_id", user.id)
          .in("session_id", sessions.map((x) => x.id))
          .order("ended_at", { ascending: false })
          .limit(HISTORY_ANSWERS)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (spots.error) throw spots.error;
  if (nodes.error) throw nodes.error;
  if (answers.error) throw answers.error;
  if (hands.error) throw hands.error;

  const spotNames = new Map((spots.data ?? []).map((x) => [x.id as string, x.name as string]));
  const nodeById = new Map(((nodes.data ?? []) as PokerNode[]).map((x) => [x.id, x]));

  // Decisions answered and nodes where hands ended, named for the history tab.
  const handRows = (hands.data ?? []) as TrainerHand[];
  const answerRows = (answers.data ?? []) as TrainerAnswer[];
  const endIds = [
    ...new Set([...handRows.map((h) => h.end_node_id), ...answerRows.map((a) => a.node_id)].filter((x): x is string => !!x)),
  ];
  const nodeInfo: TrainerPage["nodeInfo"] = {};
  for (let i = 0; i < endIds.length; i += 100) {
    const { data, error } = await supabase
      .from("poker_nodes")
      .select("id, spot_id, parent_id, type, position, data, created_at, updated_at")
      .eq("user_id", user.id)
      .in("id", endIds.slice(i, i + 100));
    if (error) throw error;
    for (const n of (data ?? []) as PokerNode[]) {
      nodeInfo[n.id] = { label: entryLabel(n), spotId: n.spot_id, spotName: spotNames.get(n.spot_id) ?? "Spot" };
    }
  }

  return {
    trainer: t.data as Trainer,
    nodes: rows.map((r) => {
      const node = nodeById.get(r.node_id);
      return {
        ...r,
        spotName: spotNames.get(r.spot_id) ?? "Spot",
        label: node ? entryLabel(node) : null,
        missing: !node,
      };
    }),
    sessions,
    answers: answerRows,
    hands: handRows,
    nodeInfo,
  };
}

export async function getSessionReview(trainerId: string, sessionId: string) {
  const { supabase, user } = await userClient();
  const [t, s, a, h] = await Promise.all([
    supabase.from("poker_trainers").select(TRAINER_SELECT).eq("id", trainerId).eq("user_id", user.id).maybeSingle(),
    supabase
      .from("poker_trainer_sessions")
      .select(SESSION_SELECT)
      .eq("id", sessionId)
      .eq("trainer_id", trainerId)
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("poker_trainer_answers")
      .select(ANSWER_SELECT)
      .eq("session_id", sessionId)
      .eq("user_id", user.id)
      .order("answered_at"),
    supabase
      .from("poker_trainer_hands")
      .select(HAND_SELECT)
      .eq("session_id", sessionId)
      .eq("user_id", user.id)
      .order("ended_at"),
  ]);
  if (t.error) throw t.error;
  if (s.error) throw s.error;
  if (a.error) throw a.error;
  if (h.error) throw h.error;
  if (!t.data || !s.data) return null;
  return {
    trainer: t.data as Trainer,
    session: s.data as TrainerSession,
    answers: (a.data ?? []) as TrainerAnswer[],
    hands: (h.data ?? []) as TrainerHand[],
  };
}
