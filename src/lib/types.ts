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
  category_id: string | null;
  title: string;
  notes: string | null;
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
  name: string;
  color: string | null;
  default_minutes: number;
  default_category_id: string | null;
  preferred_daypart: "morning" | "afternoon" | "evening" | null;
  archived: boolean;
  block_items: BlockItem[];
};

export type ScheduledStatus = "planned" | "done" | "skipped";

export type ScheduledBlockTask = {
  task_id: string;
  planned_minutes: number;
  tasks: Pick<Task, "id" | "title" | "category_id" | "estimated_minutes"> | null;
};

export type ScheduledBlock = {
  id: string;
  week_id: string;
  starts_at: string;
  ends_at: string;
  title: string;
  category_id: string | null;
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
      title: string;
      minutes: number;
      categoryId: string | null;
    }
  | {
      kind: "block";
      id: string;
      title: string;
      minutes: number;
      categoryId: string | null;
    };
