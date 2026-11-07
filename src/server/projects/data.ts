import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Result } from "@/server/agenda/tasks";
import { isUuid } from "@/lib/agenda/backlog";
import { focusLine, projectStats, type ProjectStats } from "@/lib/projects/clock";
import {
  LIMITS,
  compareSteps,
  isUnreadFor,
  type Item,
  type ItemStatus,
  type Message,
  type MessageKind,
  type Project,
  type ProjectStatus,
  type Step,
  type StepStatus,
  type StepTotals,
  type StepWithSpent,
  type Surface,
  type Triage,
  type Who,
  type WorkEntry,
  type WorkSource,
} from "@/lib/projects/types";

/**
 * /projects persistence shared by the pages' server actions and the Claude
 * connector, on the model of server/jobs/data.ts: every function takes the
 * client to act through (cookie-bound for the UI, bearer-token for Claude).
 * Both run as the user under RLS, and the rules of migration 0030 — what
 * Claude may not do, one open step, append-only work — apply without anything
 * here having to know who is calling. The `reader` passed in only decides
 * which messages count as unread.
 *
 * Throws on unexpected database errors; returns `{ ok: false }` with a
 * sentence for anything the caller should show.
 */

export const PROJECT_COLUMNS =
  "id, slug, name, question, deliverable, deadline, objectives, delegated_md, stopping_rules_md, repo_url, category_id, status, validated_at, next_action, next_action_minutes, next_action_at, next_action_by, created_at, updated_at";
export const STEP_COLUMNS =
  "id, project_id, milestone, code, title, good_enough, budget_minutes, cut_minutes, status, position, opened_at, closed_at, close_note";
export const ITEM_COLUMNS =
  "id, project_id, step_id, kind, title, triage, origin, created_as, blocks_step_id, status, position, closed_at, close_note, created_at";
export const MESSAGE_COLUMNS = "id, project_id, step_id, author, kind, body, surface, read_at, created_at";
export const WORK_COLUMNS = "id, step_id, minutes, source, note, created_by, at";

const ZERO: StepTotals = { spent: 0, claude_code: 0, claude_ai: 0, app: 0, reported: 0 };

/* ---------------------------------------------------------------- errors */

type PgError = { code?: string; message?: string; details?: string };

/** A database refusal as a sentence: the triggers of 0030 already speak. */
export function explain(e: unknown): string {
  const err = (e ?? {}) as PgError;
  const msg = err.message ?? String(e);
  if (err.code === "23505" && msg.includes("research_steps_one_open_idx")) {
    return "Another step of this project is open: close it first.";
  }
  if (err.code === "23505" && msg.includes("slug")) return "That slug is already used by another project.";
  if (err.code === "23505" && msg.includes("code")) return "That step code is already used in this project.";
  if (err.code === "23503" && msg.includes("research_work_step_id_fkey")) {
    return "This step has logged time, which is history: drop it instead of deleting it.";
  }
  if (err.code === "23514") {
    if (msg.includes("cut_after_budget")) return "The cut line must be at or above the budget.";
    if (msg.includes("slug")) return "A slug is 2–12 characters: capitals, digits and dashes (e.g. MAD).";
    if (msg.includes("objectives")) return "At most 4 objectives, each 1–200 characters.";
    return `Value out of range (${msg.replace(/^new row for relation "(\w+)" violates check constraint /, "")}).`;
  }
  return msg;
}

/** Errors the caller should see as a sentence rather than a crash. */
function isRefusal(e: unknown): boolean {
  const code = (e as PgError)?.code ?? "";
  // P0001 raise_exception, 42501 our refusals / RLS, 23xxx constraints, 22xxx bad values.
  return code === "P0001" || code === "42501" || code.startsWith("23") || code.startsWith("22");
}

async function run<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() } as Result<T>;
  } catch (e) {
    if (isRefusal(e)) return { ok: false, error: explain(e) };
    throw e;
  }
}

function cleanLine(s: string | null | undefined): string | null {
  const t = s?.trim().replace(/\s+/g, " ");
  return t ? t : null;
}

function cleanBlock(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

function tooLong(value: string | null, max: number, what: string): string | null {
  return value && value.length > max ? `${what}: at most ${max} characters.` : null;
}

/* -------------------------------------------------------------- projects */

export async function listProjects(
  db: SupabaseClient,
  userId: string,
  statuses?: ProjectStatus[],
): Promise<Project[]> {
  let q = db.from("research_projects").select(PROJECT_COLUMNS).eq("user_id", userId);
  if (statuses?.length) q = q.in("status", statuses);
  const { data, error } = await q.order("updated_at", { ascending: false });
  if (error) throw error;
  const order: Record<ProjectStatus, number> = { active: 0, draft: 1, paused: 2, done: 3 };
  return ((data ?? []) as Project[]).sort((a, b) => order[a.status] - order[b.status]);
}

/** A project by slug (any case) or id. */
export async function findProject(db: SupabaseClient, userId: string, ref: string): Promise<Project | null> {
  const r = ref.trim();
  let q = db.from("research_projects").select(PROJECT_COLUMNS).eq("user_id", userId);
  q = isUuid(r) ? q.eq("id", r) : q.eq("slug", r.toUpperCase());
  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return (data as Project | null) ?? null;
}

export type ProjectFields = Partial<{
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
  slug: string;
}>;

function checkProjectFields(f: ProjectFields): { row: Record<string, unknown> } | { error: string } {
  const row: Record<string, unknown> = {};
  if (f.slug !== undefined) {
    const slug = f.slug.trim().toUpperCase();
    if (!LIMITS.slug.test(slug)) return { error: "A slug is 2–12 characters: capitals, digits and dashes (e.g. MAD)." };
    row.slug = slug;
  }
  if (f.name !== undefined) {
    const name = cleanLine(f.name);
    if (!name) return { error: "Give the project a name." };
    const p = tooLong(name, LIMITS.name, "The name");
    if (p) return { error: p };
    row.name = name;
  }
  for (const [key, max, what] of [
    ["question", LIMITS.question, "The question"],
    ["deliverable", LIMITS.deliverable, "The deliverable"],
  ] as const) {
    if (f[key] !== undefined) {
      const v = cleanLine(f[key]);
      const p = tooLong(v, max, what);
      if (p) return { error: p };
      row[key] = v;
    }
  }
  for (const [key, what] of [
    ["delegated_md", "What may be delegated"],
    ["stopping_rules_md", "The stopping rules"],
  ] as const) {
    if (f[key] !== undefined) {
      const v = cleanBlock(f[key]);
      const p = tooLong(v, LIMITS.longText, what);
      if (p) return { error: p };
      row[key] = v;
    }
  }
  if (f.deadline !== undefined) {
    if (f.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(f.deadline)) return { error: "Deadline: use YYYY-MM-DD." };
    row.deadline = f.deadline || null;
  }
  if (f.objectives !== undefined) {
    const objectives = f.objectives.map((o) => cleanLine(o)).filter((o): o is string => !!o);
    if (objectives.length > LIMITS.objectives) return { error: `At most ${LIMITS.objectives} learning objectives.` };
    const long = objectives.find((o) => o.length > LIMITS.objective);
    if (long) return { error: `An objective is at most ${LIMITS.objective} characters.` };
    row.objectives = objectives;
  }
  if (f.repo_url !== undefined) {
    const url = cleanLine(f.repo_url);
    if (url && (!/^https?:\/\//.test(url) || url.length > LIMITS.repoUrl)) return { error: "The repo link must be an http(s) URL." };
    row.repo_url = url;
  }
  if (f.category_id !== undefined) row.category_id = f.category_id || null;
  if (f.status !== undefined) row.status = f.status;
  return { row };
}

/** Create the project if the slug is new (as a draft unless told otherwise), else update it. */
export async function saveProject(
  db: SupabaseClient,
  userId: string,
  ref: string,
  fields: ProjectFields,
): Promise<Result<{ project: Project; created: boolean }>> {
  const checked = checkProjectFields(fields);
  if ("error" in checked) return { ok: false, error: checked.error };

  const existing = await findProject(db, userId, ref);
  if (existing) {
    if (Object.keys(checked.row).length === 0) return { ok: true, value: { project: existing, created: false } };
    return run(async () => {
      const { data, error } = await db
        .from("research_projects")
        .update(checked.row)
        .eq("user_id", userId)
        .eq("id", existing.id)
        .select(PROJECT_COLUMNS)
        .single();
      if (error) throw error;
      return { project: data as Project, created: false };
    });
  }

  if (isUuid(ref.trim())) return { ok: false, error: `No project with id ${ref}.` };
  const slug = ref.trim().toUpperCase();
  if (!LIMITS.slug.test(slug)) return { ok: false, error: "A slug is 2–12 characters: capitals, digits and dashes (e.g. MAD)." };
  if (!checked.row.name) return { ok: false, error: "A new project needs a name." };
  return run(async () => {
    const { data, error } = await db
      .from("research_projects")
      .insert({ user_id: userId, slug, ...checked.row })
      .select(PROJECT_COLUMNS)
      .single();
    if (error) throw error;
    return { project: data as Project, created: true };
  });
}

export async function setNextAction(
  db: SupabaseClient,
  userId: string,
  projectId: string,
  text: string | null,
  minutes: number | null,
): Promise<Result> {
  const t = cleanLine(text);
  const p = tooLong(t, LIMITS.nextAction, "The next action");
  if (p) return { ok: false, error: p };
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 600)) {
    return { ok: false, error: "The next action takes 1–600 minutes." };
  }
  const r = await run(async () => {
    const { error } = await db
      .from("research_projects")
      .update({ next_action: t, next_action_minutes: t ? minutes : null })
      .eq("user_id", userId)
      .eq("id", projectId);
    if (error) throw error;
  });
  return r.ok ? { ok: true } : r;
}

export async function deleteProject(db: SupabaseClient, userId: string, projectId: string): Promise<Result> {
  const r = await run(async () => {
    const { error } = await db.from("research_projects").delete().eq("user_id", userId).eq("id", projectId);
    if (error) throw error;
  });
  return r.ok ? { ok: true } : r;
}

/* ----------------------------------------------------------------- state */

export type ProjectState = {
  project: Project;
  steps: StepWithSpent[];
  open: StepWithSpent | null;
  /** Open and closed items, plan order. */
  items: Item[];
  /** Oldest first. */
  messages: Message[];
  stats: ProjectStats;
};

async function loadTotals(db: SupabaseClient, projectIds: string[]): Promise<Map<string, StepTotals>> {
  if (!projectIds.length) return new Map();
  const { data, error } = await db
    .from("research_step_totals")
    .select("step_id, spent, claude_code, claude_ai, app, reported")
    .in("project_id", projectIds);
  if (error) throw error;
  return new Map(
    (data ?? []).map((r) => {
      const { step_id, ...totals } = r as StepTotals & { step_id: string };
      return [step_id, totals];
    }),
  );
}

/**
 * Everything about some projects in four queries. `messageLimit` keeps the
 * most recent messages of each project (plus every unread one).
 */
export async function loadStates(
  db: SupabaseClient,
  userId: string,
  projects: Project[],
  opts: { itemStatuses?: ItemStatus[]; messageLimit?: number } = {},
): Promise<ProjectState[]> {
  const ids = projects.map((p) => p.id);
  if (!ids.length) return [];

  let itemsQ = db.from("research_items").select(ITEM_COLUMNS).eq("user_id", userId).in("project_id", ids);
  if (opts.itemStatuses) itemsQ = itemsQ.in("status", opts.itemStatuses);

  const [stepsR, itemsR, messagesR, totals] = await Promise.all([
    db.from("research_steps").select(STEP_COLUMNS).eq("user_id", userId).in("project_id", ids),
    itemsQ.order("position").order("created_at"),
    db
      .from("research_messages")
      .select(MESSAGE_COLUMNS)
      .eq("user_id", userId)
      .in("project_id", ids)
      .order("created_at", { ascending: false })
      .limit(Math.max(50, (opts.messageLimit ?? 50) * ids.length)),
    loadTotals(db, ids),
  ]);
  if (stepsR.error) throw stepsR.error;
  if (itemsR.error) throw itemsR.error;
  if (messagesR.error) throw messagesR.error;

  const steps = ((stepsR.data ?? []) as Step[])
    .map((s) => ({ ...s, totals: totals.get(s.id) ?? ZERO }))
    .sort(compareSteps);
  const items = (itemsR.data ?? []) as Item[];
  const messages = ((messagesR.data ?? []) as Message[]).reverse();

  return projects.map((project) => {
    const pSteps = steps.filter((s) => s.project_id === project.id);
    const pItems = items.filter((i) => i.project_id === project.id);
    let pMessages = messages.filter((m) => m.project_id === project.id);
    if (opts.messageLimit && pMessages.length > opts.messageLimit) {
      const keep = new Set(pMessages.slice(-opts.messageLimit).map((m) => m.id));
      pMessages = pMessages.filter((m) => keep.has(m.id) || m.read_at === null);
    }
    return {
      project,
      steps: pSteps,
      open: pSteps.find((s) => s.status === "open") ?? null,
      items: pItems,
      messages: pMessages,
      stats: projectStats(
        pSteps.map((s) => ({ ...s, spent: s.totals.spent })),
        pItems,
      ),
    };
  });
}

export async function loadState(
  db: SupabaseClient,
  userId: string,
  ref: string,
  opts?: { itemStatuses?: ItemStatus[]; messageLimit?: number },
): Promise<ProjectState | null> {
  const project = await findProject(db, userId, ref);
  if (!project) return null;
  return (await loadStates(db, userId, [project], opts))[0];
}

export function unreadFor(state: Pick<ProjectState, "messages">, reader: Who): Message[] {
  return state.messages.filter((m) => isUnreadFor(m, reader));
}

export function focusOf(state: ProjectState, reader: Who): string {
  return focusLine({
    project: state.project,
    open: state.open ? { ...state.open, spent: state.open.totals.spent } : null,
    unread: unreadFor(state, reader).length,
  });
}

/** The focus line of one project, fresh — what every connector write returns. */
export async function focusLineOf(db: SupabaseClient, userId: string, projectId: string, reader: Who): Promise<string> {
  const state = await loadState(db, userId, projectId, { itemStatuses: ["open"], messageLimit: 1 });
  return state ? focusOf(state, reader) : "";
}

/** Open step of each project, for the /agenda header chip. */
export async function activeFocus(db: SupabaseClient, userId: string): Promise<ProjectState[]> {
  const projects = await listProjects(db, userId, ["active"]);
  return loadStates(db, userId, projects, { itemStatuses: ["open"], messageLimit: 5 });
}

/* ----------------------------------------------------------------- steps */

/** A step by code within a project, or by id. */
export function findStep<T extends Pick<Step, "id" | "code">>(steps: T[], ref: string): T | null {
  const r = ref.trim();
  return steps.find((s) => s.id === r) ?? steps.find((s) => s.code === r) ?? null;
}

export type StepInput = {
  code: string;
  milestone?: string | null;
  title?: string;
  good_enough?: string | null;
  budget_minutes?: number;
  cut_minutes?: number | null;
  position?: number;
  status?: StepStatus;
};

function checkStep(s: StepInput, isNew: boolean): { row: Record<string, unknown> } | { error: string } {
  const code = s.code.trim();
  const row: Record<string, unknown> = {};
  if (!code || code.length > LIMITS.code) return { error: `A step code is 1–${LIMITS.code} characters (e.g. 2.1).` };
  if (s.milestone !== undefined) {
    const m = cleanLine(s.milestone);
    if (m && m.length > LIMITS.milestone) return { error: `${code}: a milestone label is at most ${LIMITS.milestone} characters.` };
    row.milestone = m;
  }
  if (s.title !== undefined || isNew) {
    const t = cleanLine(s.title);
    if (!t) return { error: `${code}: give the step a title.` };
    if (t.length > LIMITS.stepTitle) return { error: `${code}: a title is at most ${LIMITS.stepTitle} characters.` };
    row.title = t;
  }
  if (s.good_enough !== undefined) {
    const g = cleanBlock(s.good_enough);
    if (g && g.length > LIMITS.goodEnough) return { error: `${code}: "good enough" is at most ${LIMITS.goodEnough} characters.` };
    row.good_enough = g;
  }
  if (s.budget_minutes !== undefined || isNew) {
    const b = s.budget_minutes;
    if (b === undefined || !Number.isInteger(b) || b < LIMITS.budget[0] || b > LIMITS.budget[1]) {
      return { error: `${code}: a budget is ${LIMITS.budget[0]}–${LIMITS.budget[1]} minutes.` };
    }
    row.budget_minutes = b;
  }
  if (s.cut_minutes !== undefined && s.cut_minutes !== null) {
    if (!Number.isInteger(s.cut_minutes) || s.cut_minutes > LIMITS.cutMax) {
      return { error: `${code}: a cut line is at most ${LIMITS.cutMax} minutes.` };
    }
    row.cut_minutes = s.cut_minutes;
  }
  if (s.position !== undefined) row.position = s.position;
  if (s.status !== undefined) row.status = s.status;
  return { row };
}

/**
 * Upsert steps by code, in order. Stops at the first refusal and says which
 * step it was; the steps before it are saved.
 */
export async function saveSteps(
  db: SupabaseClient,
  userId: string,
  projectId: string,
  inputs: StepInput[],
): Promise<Result<{ created: number; updated: number }>> {
  if (inputs.length > LIMITS.stepsPerCall) return { ok: false, error: `At most ${LIMITS.stepsPerCall} steps per call.` };
  const { data, error } = await db.from("research_steps").select("id, code, position").eq("user_id", userId).eq("project_id", projectId);
  if (error) throw error;
  const existing = new Map((data ?? []).map((s) => [s.code as string, s as { id: string; code: string; position: number }]));
  let nextPos = Math.max(-1, ...[...existing.values()].map((s) => s.position)) + 1;

  let created = 0;
  let updated = 0;
  for (const input of inputs) {
    const old = existing.get(input.code.trim());
    const checked = checkStep(input, !old);
    if ("error" in checked) return { ok: false, error: `${checked.error}${created + updated ? ` (${created + updated} saved before it)` : ""}` };
    const r = await run(async () => {
      if (old) {
        if (Object.keys(checked.row).length === 0) return;
        const { error } = await db.from("research_steps").update(checked.row).eq("id", old.id).eq("user_id", userId);
        if (error) throw error;
        updated++;
      } else {
        const row = { user_id: userId, project_id: projectId, code: input.code.trim(), position: nextPos++, ...checked.row };
        const { data, error } = await db.from("research_steps").insert(row).select("id, code, position").single();
        if (error) throw error;
        existing.set(data.code, data);
        created++;
      }
    });
    if (!r.ok) return { ok: false, error: `${input.code}: ${r.error}${created + updated ? ` (${created + updated} saved before it)` : ""}` };
  }
  return { ok: true, value: { created, updated } };
}

export async function deleteStep(db: SupabaseClient, userId: string, stepId: string): Promise<Result> {
  const r = await run(async () => {
    const { error } = await db.from("research_steps").delete().eq("user_id", userId).eq("id", stepId);
    if (error) throw error;
  });
  return r.ok ? { ok: true } : r;
}

export async function openStep(db: SupabaseClient, stepId: string): Promise<Result> {
  const r = await run(async () => {
    const { error } = await db.rpc("research_open_step", { p_step: stepId });
    if (error) throw error;
  });
  return r.ok ? { ok: true } : r;
}

export async function closeStep(
  db: SupabaseClient,
  input: { stepId: string; outcome: "done" | "cut"; note: string; nextStepId?: string | null; surface?: Surface },
): Promise<Result<{ spent: number; budget: number; ratio: number }>> {
  const note = cleanLine(input.note);
  if (!note) return { ok: false, error: "Say in one line how the step ended." };
  if (note.length > LIMITS.closeNote) return { ok: false, error: `The close note is at most ${LIMITS.closeNote} characters.` };
  return run(async () => {
    const { data, error } = await db.rpc("research_close_step", {
      p_step: input.stepId,
      p_outcome: input.outcome,
      p_note: note,
      p_next_step: input.nextStepId ?? null,
      p_surface: input.surface ?? null,
    });
    if (error) throw error;
    const d = data as { spent: number; budget: number; ratio: number | string };
    return { spent: d.spent, budget: d.budget, ratio: Number(d.ratio) };
  });
}

/* ------------------------------------------------------------------ work */

export async function logWork(
  db: SupabaseClient,
  userId: string,
  input: { stepId: string; minutes: number; source: WorkSource; note?: string | null },
): Promise<Result> {
  const m = input.minutes;
  if (!Number.isInteger(m) || m === 0 || Math.abs(m) > LIMITS.workMinutes) {
    return { ok: false, error: `Minutes: a whole number between -${LIMITS.workMinutes} and ${LIMITS.workMinutes}, not 0.` };
  }
  const note = cleanLine(input.note);
  const p = tooLong(note, LIMITS.workNote, "The note");
  if (p) return { ok: false, error: p };
  const r = await run(async () => {
    const { error } = await db
      .from("research_work")
      .insert({ user_id: userId, step_id: input.stepId, minutes: m, source: input.source, note });
    if (error) throw error;
  });
  return r.ok ? { ok: true } : r;
}

export async function loadWork(db: SupabaseClient, userId: string, stepId: string): Promise<WorkEntry[]> {
  const { data, error } = await db
    .from("research_work")
    .select(WORK_COLUMNS)
    .eq("user_id", userId)
    .eq("step_id", stepId)
    .order("at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as WorkEntry[];
}

/* ----------------------------------------------------------------- items */

export type ItemInput = {
  id?: string;
  title?: string;
  /** Step id, or null to park. Undefined leaves it where it is (new items: parked). */
  step_id?: string | null;
  triage?: Triage | null;
  blocks_step_id?: string | null;
  status?: ItemStatus;
  close_note?: string | null;
  position?: number;
};

export async function saveItems(
  db: SupabaseClient,
  userId: string,
  projectId: string,
  inputs: ItemInput[],
): Promise<Result<{ created: number; updated: number }>> {
  if (inputs.length > LIMITS.itemsPerCall) return { ok: false, error: `At most ${LIMITS.itemsPerCall} items per call.` };
  let created = 0;
  let updated = 0;
  for (const [n, input] of inputs.entries()) {
    const label = input.id ? `item ${input.id}` : `item #${n + 1}`;
    const row: Record<string, unknown> = {};
    if (input.title !== undefined) {
      const t = cleanLine(input.title);
      if (!t) return { ok: false, error: `${label}: an item needs a title.` };
      if (t.length > LIMITS.itemTitle) return { ok: false, error: `${label}: a title is at most ${LIMITS.itemTitle} characters.` };
      row.title = t;
    }
    if (input.step_id !== undefined) row.step_id = input.step_id;
    if (input.triage !== undefined) row.triage = input.triage;
    if (input.blocks_step_id !== undefined) row.blocks_step_id = input.blocks_step_id;
    if (input.status !== undefined) row.status = input.status;
    if (input.position !== undefined) row.position = input.position;
    if (input.close_note !== undefined) {
      const c = cleanLine(input.close_note);
      if (c && c.length > LIMITS.itemNote) return { ok: false, error: `${label}: a close note is at most ${LIMITS.itemNote} characters.` };
      row.close_note = c;
    }

    const r = await run(async () => {
      if (input.id) {
        const { data, error } = await db
          .from("research_items")
          .update(row)
          .eq("user_id", userId)
          .eq("project_id", projectId)
          .eq("id", input.id)
          .select("id");
        if (error) throw error;
        if (!data?.length) throw Object.assign(new Error(`No item ${input.id} in this project.`), { code: "P0001" });
        updated++;
      } else {
        if (!row.title) throw Object.assign(new Error("A new item needs a title."), { code: "P0001" });
        const { error } = await db.from("research_items").insert({ user_id: userId, project_id: projectId, ...row });
        if (error) throw error;
        created++;
      }
    });
    if (!r.ok) return { ok: false, error: `${label}: ${r.error}${created + updated ? ` (${created + updated} saved before it)` : ""}` };
  }
  return { ok: true, value: { created, updated } };
}

export async function deleteItem(db: SupabaseClient, userId: string, itemId: string): Promise<Result> {
  const r = await run(async () => {
    const { error } = await db.from("research_items").delete().eq("user_id", userId).eq("id", itemId);
    if (error) throw error;
  });
  return r.ok ? { ok: true } : r;
}

/* -------------------------------------------------------------- messages */

export async function sendMessage(
  db: SupabaseClient,
  userId: string,
  input: { projectId: string; body: string; kind: MessageKind; stepId?: string | null; surface: Surface },
): Promise<Result<Message>> {
  const body = cleanBlock(input.body);
  if (!body) return { ok: false, error: "The message is empty." };
  if (body.length > LIMITS.messageBody) return { ok: false, error: `A message is at most ${LIMITS.messageBody} characters.` };
  return run(async () => {
    const { data, error } = await db
      .from("research_messages")
      .insert({
        user_id: userId,
        project_id: input.projectId,
        step_id: input.stepId ?? null,
        kind: input.kind,
        body,
        surface: input.surface,
      })
      .select(MESSAGE_COLUMNS)
      .single();
    if (error) throw error;
    return data as Message;
  });
}

/** Mark messages read. Returns how many changed. */
export async function markRead(
  db: SupabaseClient,
  userId: string,
  ids: string[],
  opts: { author?: Who } = {},
): Promise<Result<number>> {
  if (!ids.length) return { ok: true, value: 0 };
  return run(async () => {
    let q = db
      .from("research_messages")
      .update({ read_at: new Date().toISOString() })
      .eq("user_id", userId)
      .in("id", ids)
      .is("read_at", null);
    if (opts.author) q = q.eq("author", opts.author);
    const { data, error } = await q.select("id");
    if (error) throw error;
    return data?.length ?? 0;
  });
}

/** Arthur opened the project: Claude's messages are read. */
export async function markClaudeMessagesRead(db: SupabaseClient, userId: string, projectId: string): Promise<void> {
  const { error } = await db
    .from("research_messages")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("project_id", projectId)
    .eq("author", "claude")
    .is("read_at", null);
  if (error) throw error;
}

export async function deleteMessage(db: SupabaseClient, userId: string, messageId: string): Promise<Result> {
  const r = await run(async () => {
    const { error } = await db.from("research_messages").delete().eq("user_id", userId).eq("id", messageId);
    if (error) throw error;
  });
  return r.ok ? { ok: true } : r;
}
