/**
 * Domain types for /poker/trainers. DB rows mirror the columns (snake_case);
 * the context read out of a Solver notes tree is camelCase.
 */

import type { Seat } from "../solver/seats";
import type { ActionKind, StrategyAction, StrategyWeights } from "../solver/types";

export type Street = "preflop" | "flop" | "turn" | "river";

export const STREET_LABELS: Record<Street, string> = {
  preflop: "Preflop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
};

/** One action on the current street before hero's decision. */
export type LineAction = {
  seat: Seat;
  kind: ActionKind;
  sizePct: number | null;
  label: string;
};

/** What a strategy node's ancestors say about the hand, read top-down. */
export type NodeContext = {
  spotId: string;
  street: Street;
  board: string[];
  line: LineAction[];
  /** Who plays the node — hero when it is trained. */
  seat: Seat;
  vsSeat: Seat;
};

export type Trainer = {
  id: string;
  name: string;
  hero_seat: Seat;
  villain_seat: Seat;
  pot_bb: number;
  stack_bb: number;
  street: Street | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
};

export type TrainerNodeRow = {
  trainer_id: string;
  node_id: string;
  spot_id: string;
  street: Street;
  board: string[];
  line: LineAction[];
  hero_seat: Seat;
  villain_seat: Seat;
  weight: number;
  resolved_at: string;
  added_at: string;
};

export type Grade = "correct" | "wrong_band" | "mistake" | "blunder";

export const GRADE_LABELS: Record<Grade, string> = {
  correct: "Correct",
  wrong_band: "Wrong band",
  mistake: "Mistake",
  blunder: "Blunder",
};

export type TrainerSession = {
  id: string;
  trainer_id: string;
  started_at: string;
  ended_at: string | null;
  hands: number;
  correct: number;
  blunders: number;
  last_answer_at: string | null;
};

export type TrainerAnswer = {
  id: string;
  session_id: string;
  node_id: string | null;
  combo: string;
  board: string[];
  actions: StrategyAction[];
  freqs: number[];
  rng: number;
  expected_action_id: string;
  chosen_action_id: string;
  chosen_freq: number;
  grade: Grade;
  answered_ms: number | null;
  answered_at: string;
};

/** Everything the practice screen needs for one node, loaded once per session. */
export type DrillNode = {
  nodeId: string;
  spotId: string;
  spotName: string;
  label: string | null;
  weight: number;
  context: NodeContext;
  actions: StrategyAction[];
  weights: StrategyWeights;
};
