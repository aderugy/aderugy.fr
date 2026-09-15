export type Category = {
  id: string;
  parent_id: string | null;
  name: string;
  color: string | null;
  position: number;
  archived: boolean;
};

/** 1 = urgent, 4 = someday. Low number sorts first. */
export type Priority = 1 | 2 | 3 | 4;

export const PRIORITY_LABELS: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Normal",
  4: "Someday",
};

export type TaskStatus = "backlog" | "scheduled" | "done" | "dropped";

export type Task = {
  id: string;
  /** Required: the category is the label. */
  category_id: string;
  description: string | null;
  estimated_minutes: number;
  priority: number;
  deadline: string | null;
  status: TaskStatus;
  splittable: boolean;
  /**
   * Created inside a block and owned by it. It never reaches the backlog, and
   * it is deleted with the block rather than surviving it.
   */
  ad_hoc: boolean;
  completed_at: string | null;
  created_at: string;
};

export type BlockItem = {
  id: string;
  block_id: string;
  position: number;
  label: string;
  estimated_minutes: number;
  category_id: string | null;
};

export type Block = {
  id: string;
  /** Templates keep a name of their own — it spans categories. */
  name: string;
  color: string | null;
  default_minutes: number;
  default_category_id: string;
  preferred_daypart: "morning" | "afternoon" | "evening" | null;
  archived: boolean;
  block_items: BlockItem[];
};

export type ScheduledStatus = "planned" | "done" | "skipped";

export type ScheduledBlockTask = {
  task_id: string;
  planned_minutes: number;
  /** Order inside the block: children are stacked top to bottom by this. */
  position: number;
  tasks: Pick<
    Task,
    "id" | "description" | "category_id" | "estimated_minutes" | "ad_hoc"
  > | null;
};

/**
 * A span of time on the grid, and nothing more.
 *
 * A block has no category of its own: what its hours count as is decided by the
 * tasks inside it, each with its own category and its own planned minutes. A
 * block with no tasks is time you have reserved but not yet attributed.
 */
export type ScheduledBlock = {
  id: string;
  week_id: string;
  starts_at: string;
  ends_at: string;
  description: string | null;
  source_block_id: string | null;
  status: ScheduledStatus;
  actual_minutes: number | null;
  scheduled_block_tasks: ScheduledBlockTask[];
};

export type Week = {
  id: string;
  week_start: string;
  theme: string | null;
  guidelines: string | null;
};

export type Objective = {
  id: string;
  week_id: string;
  title: string;
  category_id: string | null;
  target_minutes: number | null;
  done: boolean;
  position: number;
};

/** What a rail item carries through a drag onto the grid. */
export type DragPayload =
  | {
      kind: "task";
      id: string;
      /** What the rail showed — the category leaf, or the template's name. */
      label: string;
      minutes: number;
      categoryId: string;
      description: string | null;
    }
  | {
      kind: "block";
      id: string;
      label: string;
      minutes: number;
      /** Only a fallback colour for the drop preview; the block itself has none. */
      categoryId: string;
    };

// ------------------------------------------------------- Calendar sources

/** A calendar you connected, named and coloured yourself. */
export type CalendarSource = {
  id: string;
  provider: string;
  external_id: string;
  /** Yours, not the provider's. This is what the grid reads. */
  display_name: string;
  color: string;
  /** What this calendar's hours count as. Required before it can be enabled. */
  category_id: string | null;
  enabled: boolean;
  include_all_day: boolean;
  include_free: boolean;
  include_declined: boolean;
  position: number;
};

export type ExternalEvent = {
  calendar_source_id: string;
  external_event_id: string;
  /** The event's own title, which becomes the block's description. */
  title: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  status: string;
  /** "opaque" blocks time; "transparent" is the provider's own "show me as free". */
  transparency: string;
  attendee_response: string | null;
  /**
   * Set when the calendar dropped this event after it had already happened.
   *
   * The row outlives the deletion — an hour you spent does not stop having been
   * spent because the calendar tidied itself up — so it keeps its place on the
   * grid and in the totals. Nothing but you can remove it.
   */
  archived_at: string | null;
};

export type GoogleAccount = {
  google_email: string | null;
  connected_at: string;
  disconnected_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
};

export type GoogleSyncState = {
  google_calendar_id: string;
  summary: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
};

/** One task drawn inside its block, already resolved and placed. */
export type GridChild = {
  /** The task id. Unique within the block, which is all the grid needs. */
  id: string;
  /** The task's category leaf — what this slice of the block counts as. */
  label: string;
  /** That leaf's id, so the grid can tell whether it is currently hidden. */
  categoryId: string | null;
  description: string | null;
  color: string;
  minutes: number;
  /** Minutes from the top of the block: children stack in order. */
  offsetMinutes: number;
};

/**
 * What the grid actually draws. Own blocks and external events are stored
 * separately — the mirror is read-only and has no category of its own — but
 * they lay out together, so the grid takes one normalised list.
 */
export type GridItem = {
  id: string;
  kind: "block" | "external";
  /**
   * What this item's hours count as, when the item knows: a calendar's
   * category. Always null for your own blocks — a block has no category, only
   * the tasks inside it do.
   */
  categoryId: string | null;
  startsAt: string;
  endsAt: string;
  /** Template name, own description, or calendar name. May be empty. */
  label: string;
  description: string | null;
  color: string;
  done: boolean;
  /** External events are never movable: the next sync would revert it. */
  movable: boolean;
  /** The tasks inside a block. Always empty for an external event. */
  children: GridChild[];
  /** The children ask for more time than the block holds. */
  overfilled: boolean;
  /**
   * An external event the calendar has deleted and the planner kept. Drawn
   * differently, counted the same, and removable only from the detail panel.
   * Always false for your own blocks.
   */
  archived: boolean;
};

export type AllDayItem = {
  id: string;
  dayIndex: number;
  label: string;
  /** The calendar's category. See `GridItem.categoryId`. */
  categoryId: string | null;
  title: string | null;
  color: string;
  /** Kept after the calendar deleted it. See `GridItem.archived`. */
  archived: boolean;
};
