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
  tasks: Pick<
    Task,
    "id" | "description" | "category_id" | "estimated_minutes"
  > | null;
};

export type ScheduledBlock = {
  id: string;
  week_id: string;
  starts_at: string;
  ends_at: string;
  description: string | null;
  category_id: string;
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
    }
  | {
      kind: "block";
      id: string;
      label: string;
      minutes: number;
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

/**
 * What the grid actually draws. Own blocks and external events are stored
 * separately — the mirror is read-only and has no category of its own — but
 * they lay out together, so the grid takes one normalised list.
 */
export type GridItem = {
  id: string;
  kind: "block" | "external";
  startsAt: string;
  endsAt: string;
  /** Category leaf, template name, or calendar name. */
  label: string;
  description: string | null;
  color: string;
  done: boolean;
  /** External events are never movable: the next sync would revert it. */
  movable: boolean;
};

export type AllDayItem = {
  id: string;
  dayIndex: number;
  label: string;
  title: string | null;
  color: string;
};
