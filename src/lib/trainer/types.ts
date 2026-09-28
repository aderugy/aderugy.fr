/**
 * Domain types for /poker/trainers. DB rows mirror the columns (snake_case);
 * what is read out of a Solver notes tree is camelCase.
 */

import type { Seat } from "../solver/seats";
import type { ActionKind, PokerNode, SpotSetup, StrategyAction, StrategyWeights, Street } from "../solver/types";

export type { Street } from "../solver/types";
export { STREET_LABELS } from "../solver/types";

/** One action of the hand before an entry node (whole hand, every street). */
export type LineAction = {
  street?: Street;
  seat: Seat;
  kind: ActionKind;
  label: string;
  /** What the seat has in front after it (null for check / fold). */
  amountBb?: number | null;
  /** Legacy rows (before 0013) stored the sizing instead. */
  sizePct?: number | null;
};

/** Where a hand starts, read from the tree above an entry node. */
export type EntryContext = {
  spotId: string;
  players: [Seat, Seat];
  street: Street;
  board: string[];
  line: LineAction[];
  potBb: number;
  stackBb: number;
  /** Who acts next at the entry (null between streets). */
  toAct: Seat | null;
};

export type Feedback = "each" | "hand_end";

export type Trainer = {
  id: string;
  name: string;
  hero_seat: Seat;
  villain_seat: Seat;
  /** Unused since the pot comes from the tree (kept on old rows). */
  pot_bb: number | null;
  stack_bb: number;
  street: Street | null;
  stop_at_street_end: boolean;
  feedback: Feedback;
  archived: boolean;
  created_at: string;
  updated_at: string;
};

/** An entry node of a trainer, with the context last read from its tree. */
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

export type EndReason =
  | "fold"
  | "showdown"
  | "allin"
  | "end_of_solution"
  | "branch_not_developed"
  | "off_range"
  | "no_runout"
  | "end_of_street";

export const END_LABELS: Record<EndReason, string> = {
  fold: "Hand over",
  showdown: "Showdown",
  allin: "All-in — runout",
  end_of_solution: "End of solution",
  branch_not_developed: "Branch not developed",
  off_range: "Off range",
  no_runout: "No runout available with your cards",
  end_of_street: "End of street",
};

/** The tree stopped the hand, not the game: something to develop. */
export const TREE_ENDS: EndReason[] = ["end_of_solution", "branch_not_developed", "off_range", "no_runout"];

export type TrainerSession = {
  id: string;
  trainer_id: string;
  started_at: string;
  ended_at: string | null;
  /** Decisions answered (the column predates multi-decision hands). */
  hands: number;
  correct: number;
  blunders: number;
  played_hands: number;
  perfect_hands: number;
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
  hand_id: string | null;
  step: number | null;
  line: LineAction[] | null;
  pot_bb: number | null;
};

export type TrainerHand = {
  id: string;
  session_id: string;
  entry_node_id: string | null;
  end_node_id: string | null;
  combo: string | null;
  villain_combo: string | null;
  board: string[];
  line: LineAction[];
  end_reason: EndReason;
  decisions: number;
  correct: number;
  ended_at: string;
};

/** One spot of a session: its setup and the nodes a hand can go through. */
export type DrillSpot = {
  spotId: string;
  spotName: string;
  setup: SpotSetup;
  /** Paths to the entries and every node below them. */
  nodes: PokerNode[];
};

export type DrillEntry = { nodeId: string; spotId: string; weight: number; label: string };

/** Everything the practice screen needs, loaded once per session. */
export type Drill = {
  spots: Record<string, DrillSpot>;
  entries: DrillEntry[];
  /** Grids of the decision nodes below the entries. */
  weights: Record<string, StrategyWeights>;
};
