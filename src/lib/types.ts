import type { InterviewOnSession } from "@/lib/jobs/types";

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
  /** Extended description, Markdown. Shown in full in the backlog and the session panel. */
  notes: string | null;
  estimated_minutes: number;
  priority: number;
  deadline: string | null;
  status: TaskStatus;
  splittable: boolean;
  /**
   * Legacy (dropped in 0027): set on tasks drawn inside a block before
   * sessions, and still on an interview's own task, which the backlog leaves
   * out because the interview stands for it.
   */
  ad_hoc: boolean;
  completed_at: string | null;
  created_at: string;
};

export type SessionStatus = "planned" | "done" | "skipped";

/** What the grid needs of a session's task. */
export type SessionTask = Pick<
  Task,
  | "id"
  | "category_id"
  | "description"
  | "notes"
  | "estimated_minutes"
  | "priority"
  | "deadline"
  | "status"
  | "created_at"
>;

/**
 * A task placed on the grid: one task, one span of time.
 *
 * A session has no contents and no title of its own — it is drawn as its
 * task. Skipping it keeps the row, so the attempt stays in the task's history;
 * a planned session whose time has passed is "missed", which is computed when
 * read (`isMissed`) and never stored.
 */
export type TaskSession = {
  id: string;
  task_id: string;
  week_id: string;
  starts_at: string;
  ends_at: string;
  status: SessionStatus;
  /** Who placed it. Claude may change only its own sessions. */
  created_by: "app" | "claude";
  tasks: SessionTask | null;
  /** Set when the session holds a /jobs interview (added by the week page, not stored here). */
  interview?: InterviewOnSession | null;
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

/** What a rail task carries through a drag onto the grid. */
export type DragPayload = {
  kind: "task";
  id: string;
  /** What the rail showed: the category leaf. */
  label: string;
  minutes: number;
  categoryId: string;
  description: string | null;
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

/**
 * An event Arthur hid from a mirrored calendar: one occurrence
 * (`external_event_id`), or every event with that title in the calendar
 * (`title`). Hidden events leave the grid, the totals and the free-time search.
 */
export type HiddenEventRule = {
  id: string;
  calendar_source_id: string;
  external_event_id: string | null;
  title: string | null;
  /** What it looked like when hidden, for the settings list. */
  label: string | null;
  starts_at: string | null;
  created_at: string;
};

export type ExternalEvent = {
  calendar_source_id: string;
  external_event_id: string;
  /** The event's own title, shown under the calendar's name. */
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
  /** What Google granted. Pushing needs `calendar.app.created` among them. */
  scopes?: string[];
  /** Sessions are written to the app's own "Agenda" calendar. */
  push_enabled?: boolean;
  push_calendar_id?: string | null;
  last_pushed_at?: string | null;
  push_error?: string | null;
};

/** Where the push to Google stands, in counts. See the `session_push_status` view. */
export type PushStatus = {
  pending: number;
  failed: number;
  synced: number;
  last_error: string | null;
};

export type GoogleSyncState = {
  google_calendar_id: string;
  summary: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
};

/**
 * What the grid actually draws. Sessions and external events are stored
 * separately — the mirror is read-only — but they lay out together, so the
 * grid takes one normalised list.
 */
export type GridItem = {
  id: string;
  kind: "session" | "external";
  /**
   * What this item's hours count as: the session's task category, or the
   * calendar's. Null for a calendar with no category.
   */
  categoryId: string | null;
  startsAt: string;
  endsAt: string;
  /** The category leaf, or the calendar's name. May be empty. */
  label: string;
  /** The task's description, or the event's title. */
  description: string | null;
  color: string;
  /** A session's status; null for an external event. */
  status: SessionStatus | null;
  /** A planned session whose time is over, not marked done or skipped. */
  missed: boolean;
  done: boolean;
  /** External events and skipped sessions never move. */
  movable: boolean;
  /** Placed by Claude through the connector. */
  byClaude: boolean;
  /**
   * An external event the calendar has deleted and the planner kept. Drawn
   * differently, counted the same, and removable only from the detail panel.
   * Always false for sessions.
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
