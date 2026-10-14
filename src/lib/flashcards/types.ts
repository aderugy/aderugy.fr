/**
 * /flashcards — shared shapes, defaults and limits. Mirrors migration
 * 0023_flashcards.sql; keep the two in step.
 */

export const NOTE_KINDS = ["basic", "reversed", "cloze", "type_answer"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const KIND_LABELS: Record<NoteKind, string> = {
  basic: "Basic",
  reversed: "Basic + reversed",
  cloze: "Cloze",
  type_answer: "Type the answer",
};

export const CARD_STATES = ["new", "learning", "review", "relearning"] as const;
export type CardState = (typeof CARD_STATES)[number];

export const STATE_LABELS: Record<CardState, string> = {
  new: "New",
  learning: "Learning",
  review: "Review",
  relearning: "Relearning",
};

/** 1 Again · 2 Hard · 3 Good · 4 Easy — the FSRS ratings. */
export type Rating = 1 | 2 | 3 | 4;
export const RATINGS: Rating[] = [1, 2, 3, 4];
export const RATING_LABELS: Record<Rating, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };

export function isNoteKind(v: unknown): v is NoteKind {
  return typeof v === "string" && (NOTE_KINDS as readonly string[]).includes(v);
}
export function isCardState(v: unknown): v is CardState {
  return typeof v === "string" && (CARD_STATES as readonly string[]).includes(v);
}

export type Settings = {
  /** Target probability of recall, 0.70–0.97. */
  retention: number;
  newPerDay: number;
  reviewsPerDay: number;
  /** Minutes. */
  learningSteps: number[];
  /** Minutes; may be empty (a lapse goes straight back to review). */
  relearningSteps: number[];
  /** A review day starts at this hour, local time. */
  dayStartsHour: number;
  timeZone: string;
  leechThreshold: number;
  swipeGestures: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  retention: 0.9,
  newPerDay: 20,
  reviewsPerDay: 200,
  learningSteps: [1, 10],
  relearningSteps: [10],
  dayStartsHour: 4,
  timeZone: "Europe/Paris",
  leechThreshold: 8,
  swipeGestures: true,
};

export const LIMITS = {
  deckName: 80,
  field: 20000,
  source: 2000,
  tag: 60,
  tagsPerNote: 50,
  mediaBytes: 1024 * 1024,
  /** Notes per connector call and per import batch. */
  batch: 50,
  importRows: 5000,
} as const;

/** The scheduling state of one card — what the scheduler reads and writes. */
export type Memory = {
  state: CardState;
  step: number;
  stability: number;
  difficulty: number;
  /** ISO instant. */
  due: string;
  /** ISO instant, or null if never rated. */
  lastReview: string | null;
  reps: number;
  lapses: number;
};

export type Deck = {
  id: string;
  parent_id: string | null;
  name: string;
  position: number;
  archived_at: string | null;
};

export type Note = {
  id: string;
  deck_id: string;
  kind: NoteKind;
  front: string;
  back: string;
  extra: string | null;
  source: string | null;
  tags: string[];
  inbox: boolean;
  created_by: "user" | "claude";
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Card = {
  id: string;
  note_id: string;
  ord: number;
  state: CardState;
  step: number;
  stability: number;
  difficulty: number;
  due: string;
  last_review: string | null;
  reps: number;
  lapses: number;
  suspended: boolean;
  buried_until: string | null;
  flagged: boolean;
};

export function memoryOf(c: Card): Memory {
  return {
    state: c.state,
    step: c.step,
    stability: c.stability,
    difficulty: c.difficulty,
    due: c.due,
    lastReview: c.last_review,
    reps: c.reps,
    lapses: c.lapses,
  };
}

/** Columns read for a card, matching `Card`. */
export const CARD_COLUMNS =
  "id, note_id, ord, state, step, stability, difficulty, due, last_review, reps, lapses, suspended, buried_until, flagged";
export const NOTE_COLUMNS =
  "id, deck_id, kind, front, back, extra, source, tags, inbox, created_by, deleted_at, created_at, updated_at";
export const DECK_COLUMNS = "id, parent_id, name, position, archived_at";
