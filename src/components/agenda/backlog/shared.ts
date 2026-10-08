import type { Task } from "@/lib/types";

/** A task as the backlog page shows it. */
export type BacklogTask = Task & {
  /** For a scheduled task: when its next (or last) block starts, as an instant. */
  scheduled_at: string | null;
  /** The same, formatted in the app's time zone ("Thu 9 Oct 18:00"). */
  scheduled_label: string | null;
};

/**
 * One visual language for priority, used by the row's check button, the
 * filter chips and the editor: a coloured ring for the two that matter, a
 * plain one for Normal, a dashed one for Someday.
 */
export const PRIORITY_STYLE: Record<
  number,
  { label: string; short: string; color: string; ring: string }
> = {
  1: { label: "Urgent", short: "P1", color: "#e03131", ring: "border-[#e03131]" },
  2: { label: "High", short: "P2", color: "#f08c00", ring: "border-[#f08c00]" },
  3: { label: "Normal", short: "P3", color: "var(--muted)", ring: "border-muted/60" },
  4: { label: "Someday", short: "P4", color: "var(--muted)", ring: "border-muted/40 border-dashed" },
};

export const ESTIMATE_PRESETS = [15, 30, 45, 60, 90, 120, 180];
