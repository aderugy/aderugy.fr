/**
 * /projects — research projects run under the research protocol v2.
 * Shapes shared by the data layer, the server actions, the Claude connector
 * and the pages. See docs/projects/design.md and migration 0030.
 */

export const PROJECT_STATUSES = ["draft", "active", "paused", "done"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const STEP_STATUSES = ["todo", "open", "done", "cut", "dropped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const ITEM_STATUSES = ["open", "done", "dropped"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const TRIAGES = ["core", "support", "logistics"] as const;
export type Triage = (typeof TRIAGES)[number];

export const WORK_SOURCES = ["claude_code", "claude_ai", "app", "reported"] as const;
export type WorkSource = (typeof WORK_SOURCES)[number];

export const MESSAGE_KINDS = ["note", "handoff", "question", "step_closed", "next_action"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const SURFACES = ["app", "claude_code", "claude_ai"] as const;
export type Surface = (typeof SURFACES)[number];

export type Who = "arthur" | "claude";

/** Same limits as the checks in 0030. */
export const LIMITS = {
  slug: /^[A-Z0-9-]{2,12}$/,
  name: 120,
  question: 500,
  deliverable: 500,
  objectives: 4,
  objective: 200,
  longText: 4000,
  repoUrl: 500,
  nextAction: 300,
  nextActionMinutes: [1, 600] as const,
  milestone: 60,
  code: 12,
  stepTitle: 200,
  goodEnough: 500,
  budget: [5, 6000] as const,
  cutMax: 9000,
  closeNote: 1000,
  workMinutes: 600,
  workNote: 300,
  itemTitle: 300,
  itemNote: 300,
  messageBody: 4000,
  stepsPerCall: 60,
  itemsPerCall: 30,
} as const;

/** Parking lot size the protocol aims to stay under. */
export const PARKING_TARGET = 10;

export type Project = {
  id: string;
  slug: string;
  name: string;
  question: string | null;
  deliverable: string | null;
  deadline: string | null;
  objectives: string[];
  delegated_md: string | null;
  stopping_rules_md: string | null;
  repo_url: string | null;
  category_id: string | null;
  status: ProjectStatus;
  validated_at: string | null;
  next_action: string | null;
  next_action_minutes: number | null;
  next_action_at: string | null;
  next_action_by: Who | null;
  created_at: string;
  updated_at: string;
};

export type Step = {
  id: string;
  project_id: string;
  milestone: string | null;
  code: string;
  title: string;
  good_enough: string | null;
  budget_minutes: number;
  cut_minutes: number;
  status: StepStatus;
  position: number;
  opened_at: string | null;
  closed_at: string | null;
  close_note: string | null;
};

export type StepTotals = {
  spent: number;
  claude_code: number;
  claude_ai: number;
  app: number;
  reported: number;
};

export type StepWithSpent = Step & { totals: StepTotals };

export type Item = {
  id: string;
  project_id: string;
  step_id: string | null;
  kind: "todo" | "park";
  title: string;
  triage: Triage | null;
  origin: Who;
  created_as: "todo" | "park" | null;
  blocks_step_id: string | null;
  status: ItemStatus;
  position: number;
  closed_at: string | null;
  close_note: string | null;
  created_at: string;
};

export type WorkEntry = {
  id: string;
  step_id: string;
  minutes: number;
  source: WorkSource;
  note: string | null;
  created_by: Who;
  at: string;
};

export type Message = {
  id: string;
  project_id: string;
  step_id: string | null;
  author: Who;
  kind: MessageKind;
  body: string;
  surface: Surface;
  read_at: string | null;
  created_at: string;
};

/* ------------------------------------------------------------ labels (UI) */

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  draft: "brouillon",
  active: "actif",
  paused: "en pause",
  done: "terminé",
};

export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  todo: "à faire",
  open: "ouverte",
  done: "faite",
  cut: "coupée",
  dropped: "abandonnée",
};

export const TRIAGE_SHORT: Record<Triage, string> = { core: "C", support: "S", logistics: "L" };
export const TRIAGE_LABELS: Record<Triage, string> = {
  core: "cœur",
  support: "support",
  logistics: "logistique",
};

export const SOURCE_LABELS: Record<WorkSource, string> = {
  claude_code: "Claude Code",
  claude_ai: "claude.ai",
  app: "app",
  reported: "déclaré",
};

export const KIND_LABELS: Record<MessageKind, string> = {
  note: "note",
  handoff: "handoff",
  question: "question",
  step_closed: "étape fermée",
  next_action: "prochaine action",
};

/** A message that waits for the other side: notes, handoffs and questions. */
export function isUnreadFor(m: Message, reader: Who): boolean {
  return m.author !== reader && m.read_at === null && m.kind !== "next_action";
}

/** Steps in plan order: position, then code with numbers compared as numbers. */
export function compareSteps(a: Pick<Step, "position" | "code">, b: Pick<Step, "position" | "code">): number {
  return a.position - b.position || a.code.localeCompare(b.code, "fr", { numeric: true });
}

/** Milestones in the order their first step appears; steps with none go last. */
export function groupByMilestone<T extends Step>(steps: T[]): { milestone: string | null; steps: T[] }[] {
  const groups = new Map<string | null, T[]>();
  for (const s of [...steps].sort(compareSteps)) {
    const key = s.milestone?.trim() || null;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  const out = [...groups.entries()].map(([milestone, list]) => ({ milestone, steps: list }));
  return [...out.filter((g) => g.milestone !== null), ...out.filter((g) => g.milestone === null)];
}
