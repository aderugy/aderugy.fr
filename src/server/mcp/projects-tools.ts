import "server-only";
import { z } from "zod";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CLOCK_LABELS, clockOf, fmtMinutes, overrunRatio, pct } from "@/lib/projects/clock";
import { fmtWhenEn } from "@/lib/projects/format";
import {
  ITEM_STATUSES,
  LIMITS,
  PARKING_TARGET,
  TRIAGES,
  groupByMilestone,
  type Item,
  type Message,
  type StepWithSpent,
} from "@/lib/projects/types";
import {
  closeStep,
  findProject,
  findStep,
  focusLineOf,
  focusOf,
  listProjects,
  loadState,
  loadStates,
  logWork,
  markRead,
  openStep,
  saveItems,
  saveProject,
  saveSteps,
  sendMessage,
  setNextAction,
  unreadFor,
  type ItemInput,
  type ProjectState,
  type StepInput,
} from "@/server/projects/data";
import { callerOf } from "./auth";

/**
 * /projects as MCP tools, on the same connector as the backlog.
 *
 * Every call goes through server/projects/data.ts with the caller's own
 * token, so RLS and the rules of migration 0030 apply: Claude cannot validate
 * a contract, change the objectives of a validated one, move the budget, cut
 * line or "good enough" of a step once opened, reopen a step, log time as the
 * app or rewrite history, sign as Arthur, or delete anything. Those refusals
 * come back as sentences.
 *
 * Every write returns the project's focus line, so Claude never needs a
 * second read.
 */

export const PROJECTS_INSTRUCTIONS = `Arthur's research projects (aderugy.fr/projects), run under his research protocol v2. A project has a contract (question, deliverable, deadline, 2–4 learning objectives that define the "core", what may be delegated, stopping rules), steps grouped by milestone, each with a budget and a cut line, at most one open step (the focus), items (todos inside a step, triaged core / support / logistics, or parked items), a next action, and messages between Arthur and Claude. Projects are named by slug (MAD), steps by code within the project (2.1); ids work too.

At the start of every research session, call get_focus first. Act on Arthur's unread messages, then mark_read (once acted on, not on sight). Don't re-ask what the project already records. Log time on the open step with log_work: every ~30 minutes of work, and at the end; when Arthur says he worked off-chat, log it with source "reported". Past the cut line you are in closing mode: closing actions only, then close_step (done, or cut with the minimal version). Park anything off the main thread with save_items (one line, no step). Drop your own objections that wouldn't change a decision; don't park them. End every session with set_next_action and a send_message handoff (≤ 8 lines: where it stands, what was decided, the next action).

Some things are Arthur's: validating the contract, the objectives of a validated contract, the budget, cut line and "good enough" of a step once opened, reopening a step, resuming or closing a project. Propose those in a message (kind "question"); questions ring his phone.`;

/* ------------------------------------------------------------- shapes */

const projectRef = z.string().min(1).max(64).describe("Project slug (e.g. MAD) or id.");
const stepRef = z.string().min(1).max(64).describe("Step code within the project (e.g. 2.1) or id.");
const surfaceIn = z.enum(["claude_code", "claude_ai"]).describe("Where you are running.");
const dateIn = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

async function withFocus(db: SupabaseClient, userId: string, projectId: string, text: string): Promise<CallToolResult> {
  const line = await focusLineOf(db, userId, projectId, "claude");
  return ok(`${text}\n\n${line}`);
}

async function projectOr(db: SupabaseClient, userId: string, ref: string) {
  const project = await findProject(db, userId, ref);
  if (project) return { project };
  const all = await listProjects(db, userId);
  return {
    error: `No project "${ref}". Projects: ${all.map((p) => `${p.slug} (${p.status})`).join(", ") || "none yet — create one with save_project"}.`,
  };
}

/* ----------------------------------------------------------- formatting */

function spentBreakdown(s: StepWithSpent): string {
  const t = s.totals;
  const parts = [
    t.claude_code ? `Claude Code ${fmtMinutes(t.claude_code)}` : "",
    t.claude_ai ? `claude.ai ${fmtMinutes(t.claude_ai)}` : "",
    t.app ? `app ${fmtMinutes(t.app)}` : "",
    t.reported ? `reported ${fmtMinutes(t.reported)}` : "",
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function itemLine(i: Item, steps: StepWithSpent[]): string {
  const box = i.status === "done" ? "[x]" : i.status === "dropped" ? "[-]" : "[ ]";
  const triage = i.triage ? `${i.triage} · ` : "";
  const blocks = i.blocks_step_id ? ` → blocks ${steps.find((s) => s.id === i.blocks_step_id)?.code ?? "?"}` : "";
  const origin = i.origin === "claude" ? " · raised by Claude" : "";
  return `- ${box} ${triage}${i.title}${blocks}${origin} (item ${i.id})`;
}

function messageLine(m: Message): string {
  const unread = m.read_at ? "" : m.author === "arthur" && m.kind !== "next_action" ? " · UNREAD" : "";
  return `- ${fmtWhenEn(m.created_at)} · ${m.author} · ${m.kind}${unread} (message ${m.id})\n  ${m.body.replace(/\n/g, "\n  ")}`;
}

function contractDigest(state: ProjectState): string[] {
  const p = state.project;
  const lines = [`Question: ${p.question ?? "—"}`];
  if (p.objectives.length) lines.push(`Objectives (the core): ${p.objectives.map((o, n) => `${n + 1}. ${o}`).join(" ")}`);
  else lines.push("Objectives: none yet");
  if (p.delegated_md) lines.push(`May be delegated: ${p.delegated_md.replace(/\n+/g, " ")}`);
  return lines;
}

function focusBlock(state: ProjectState): string {
  const p = state.project;
  const out = [`## ${p.slug} — ${p.name} (${p.status}, project ${p.id})`, focusOf(state, "claude"), "", ...contractDigest(state)];

  const open = state.open;
  if (open) {
    const c = clockOf(open.totals.spent, open.budget_minutes, open.cut_minutes);
    out.push(
      "",
      `### Open step ${open.code} ${open.title} (step ${open.id})`,
      `Good enough: ${open.good_enough ?? "—"}`,
      `Budget ${fmtMinutes(c.budget)} · cut line ${fmtMinutes(c.cut)} · spent ${fmtMinutes(c.spent)}${spentBreakdown(open)} · ${CLOCK_LABELS[c.state]}` +
        (c.state === "closing"
          ? " → closing mode: closing actions only, then close_step."
          : ` · ${fmtMinutes(Math.max(0, c.leftBudget))} left before the budget, ${fmtMinutes(c.leftCut)} before the cut line`),
    );
    const todos = state.items.filter((i) => i.step_id === open.id && i.status === "open");
    out.push(todos.length ? `Todos:\n${todos.map((i) => itemLine(i, state.steps)).join("\n")}` : "Todos: none");
  } else if (p.status === "active") {
    const next = state.steps.find((s) => s.status === "todo");
    out.push("", `No open step.${next ? ` Next in the plan: ${next.code} ${next.title} — open it with open_step.` : ""}`);
  } else if (p.status === "draft") {
    out.push("", "The contract is a draft: Arthur validates it in the app before any step opens.");
  }

  out.push(
    "",
    p.next_action
      ? `Next action: ${p.next_action}${p.next_action_minutes ? ` (≈ ${fmtMinutes(p.next_action_minutes)})` : ""} — set by ${p.next_action_by ?? "?"}${p.next_action_at ? ` ${fmtWhenEn(p.next_action_at)}` : ""}`
      : "Next action: none",
  );

  const unread = unreadFor(state, "claude");
  out.push(unread.length ? `Unread from Arthur:\n${unread.map(messageLine).join("\n")}` : "No unread message from Arthur.");

  const parked = state.items.filter((i) => i.kind === "park" && i.status === "open");
  if (open) {
    const blocking = parked.filter((i) => i.blocks_step_id === open.id);
    if (blocking.length) out.push(`Parked items that block ${open.code}:\n${blocking.map((i) => itemLine(i, state.steps)).join("\n")}`);
  }
  out.push(`Parking: ${parked.length} open item${parked.length === 1 ? "" : "s"}${parked.length > PARKING_TARGET ? ` — over ${PARKING_TARGET}, worth a review` : ""}.`);
  return out.join("\n");
}

function projectText(state: ProjectState): string {
  const p = state.project;
  const out = [
    `# ${p.slug} — ${p.name}`,
    `project ${p.id} · ${p.status}${p.validated_at ? ` · validated ${fmtWhenEn(p.validated_at)}` : " · contract not validated"}`,
    focusOf(state, "claude"),
    "",
    "## Contract",
    `Question: ${p.question ?? "—"}`,
    `Deliverable: ${p.deliverable ?? "—"}`,
    `Deadline: ${p.deadline ?? "—"}`,
    `Learning objectives:${p.objectives.length ? `\n${p.objectives.map((o, n) => `${n + 1}. ${o}`).join("\n")}` : " —"}`,
    `May be delegated:\n${p.delegated_md ?? "—"}`,
    `Stopping rules:\n${p.stopping_rules_md ?? "—"}`,
    `Repo: ${p.repo_url ?? "—"}`,
    "",
    "## Roadmap",
  ];
  for (const g of groupByMilestone(state.steps)) {
    out.push(`### ${g.milestone ?? "(no milestone)"}`);
    for (const s of g.steps) {
      const closed = s.status === "done" || s.status === "cut";
      const ratio = closed ? ` · ratio ${overrunRatio(s.totals.spent, s.budget_minutes).toFixed(2)}` : "";
      const state_ = s.status === "open" ? ` · ${CLOCK_LABELS[clockOf(s.totals.spent, s.budget_minutes, s.cut_minutes).state]}` : "";
      out.push(
        `- ${s.code} ${s.title} — ${s.status} · budget ${fmtMinutes(s.budget_minutes)} · cut ${fmtMinutes(s.cut_minutes)} · spent ${fmtMinutes(s.totals.spent)}${ratio}${state_} (step ${s.id})` +
          (s.good_enough ? `\n  good enough: ${s.good_enough}` : "") +
          (s.close_note ? `\n  closed: ${s.close_note}` : ""),
      );
    }
  }
  if (!state.steps.length) out.push("_(no steps yet — import the plan with save_steps)_");

  const openItems = state.items.filter((i) => i.status === "open");
  out.push("", "## Open items");
  for (const s of state.steps) {
    const todos = openItems.filter((i) => i.step_id === s.id);
    if (todos.length) out.push(`### Todos of ${s.code}`, ...todos.map((i) => itemLine(i, state.steps)));
  }
  const parked = openItems.filter((i) => i.kind === "park");
  out.push(`### Parking (${parked.length})`, ...(parked.length ? parked.map((i) => itemLine(i, state.steps)) : ["_(empty)_"]));

  const st = state.stats;
  out.push(
    "",
    "## Stats",
    `Closed steps: ${st.closedSteps} · median overrun ratio ${st.medianRatio ?? "—"} · closed by the cut line ${pct(st.shareCut)}`,
    `Steps closed per week (Paris, oldest first): ${st.stepsPerWeek.map((w) => `${w.week}: ${w.count}`).join(", ")}`,
    `Parked per day (14 days): ${st.parkedPerDay} · raised by Claude ${pct(st.parkedByClaude)}`,
    "",
    "## Last messages",
    state.messages.length ? state.messages.map(messageLine).join("\n") : "_(none)_",
  );
  return out.join("\n");
}

function openItemsText(state: ProjectState): string {
  const openItems = state.items.filter((i) => i.status === "open");
  const out: string[] = [];
  if (state.open) {
    const todos = openItems.filter((i) => i.step_id === state.open!.id);
    out.push(`Todos of the open step ${state.open.code}:`, ...(todos.length ? todos.map((i) => itemLine(i, state.steps)) : ["_(none)_"]));
  }
  for (const s of state.steps) {
    if (s.id === state.open?.id) continue;
    const todos = openItems.filter((i) => i.step_id === s.id);
    if (todos.length) out.push(`Todos of ${s.code}:`, ...todos.map((i) => itemLine(i, state.steps)));
  }
  const parked = openItems.filter((i) => i.kind === "park");
  out.push(`Parking (${parked.length}/${PARKING_TARGET}):`, ...(parked.length ? parked.map((i) => itemLine(i, state.steps)) : ["_(empty)_"]));
  return out.join("\n");
}

/* -------------------------------------------------------------- tools */

export function registerProjectsTools(server: McpServer) {
  server.registerTool(
    "get_focus",
    {
      title: "Research focus (session start)",
      description:
        "Call first in every research session. Per project: the focus line, the contract digest, the open step (good enough, budget, cut line, time spent, clock state, its open todos), the next action, Arthur's unread messages, parked items blocking the open step and the parking count. Default: every active project.",
      inputSchema: z.object({ project: projectRef.optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      let projects;
      if (project) {
        const r = await projectOr(db, userId, project);
        if ("error" in r) return failure(r.error!);
        projects = [r.project];
      } else {
        projects = await listProjects(db, userId, ["active"]);
        if (!projects.length) {
          const all = await listProjects(db, userId);
          return ok(
            all.length
              ? `No active project. Others: ${all.map((p) => `${p.slug} (${p.status})`).join(", ")}. Pass project to see one.`
              : "No research project yet. Draft one with save_project, then import its plan with save_steps.",
          );
        }
      }
      const states = await loadStates(db, userId, projects, { itemStatuses: ["open"], messageLimit: 5 });
      return ok(states.map(focusBlock).join("\n\n---\n\n"));
    },
  );

  server.registerTool(
    "get_project",
    {
      title: "Read a research project in full",
      description:
        "The full contract, every step by milestone (status, budget, cut line, spent, overrun ratio), all open items, project stats and the last 20 messages. For kickoff, the weekly review and after-action reviews.",
      inputSchema: z.object({ project: projectRef }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const state = await loadState(db, userId, project, { messageLimit: 20 });
      if (!state) {
        const r = await projectOr(db, userId, project);
        return failure("error" in r ? r.error! : `No project "${project}".`);
      }
      return ok(projectText(state));
    },
  );

  server.registerTool(
    "save_project",
    {
      title: "Create or update a research project's contract",
      description:
        "Upsert by slug. A new project starts as a draft: Arthur validates the contract in the app. Once validated, the objectives are his (propose changes in a message). You may pause an active project, nothing else in its status.",
      inputSchema: z.object({
        project: z.string().min(2).max(64).describe("Slug to create (2–12 capitals, digits, dashes, e.g. MAD) or the slug/id of an existing project."),
        name: z.string().max(LIMITS.name).optional().describe("Required to create."),
        question: z.string().max(LIMITS.question).optional(),
        deliverable: z.string().max(LIMITS.deliverable).optional(),
        deadline: dateIn.nullable().optional(),
        objectives: z.array(z.string().max(LIMITS.objective)).max(LIMITS.objectives).optional().describe("2–4 learning objectives: the core."),
        delegated_md: z.string().max(LIMITS.longText).optional().describe("What may be delegated, Markdown."),
        stopping_rules_md: z.string().max(LIMITS.longText).optional().describe("Stopping rules, Markdown."),
        repo_url: z.string().max(LIMITS.repoUrl).nullable().optional(),
        status: z.enum(["paused"]).optional().describe("Only 'paused' (from active)."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, ...fields }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const r = await saveProject(db, userId, project, fields);
      if (!r.ok) return failure(r.error);
      const p = r.value.project;
      const note =
        p.status === "draft"
          ? " It is a draft: Arthur validates the contract in the app (aderugy.fr/projects) before a step can open."
          : "";
      return withFocus(db, userId, p.id, `${r.value.created ? "Created" : "Saved"} ${p.slug} — ${p.name}.${note}`);
    },
  );

  server.registerTool(
    "save_steps",
    {
      title: "Import or edit the plan",
      description: `Upsert steps by code, up to ${LIMITS.stepsPerCall} per call (importing the plan at kickoff). A new step needs a title and a budget; the cut line defaults to 1.5 × budget. Status here is only todo or dropped: opening and closing go through open_step and close_step. Once a step has been opened its budget, cut line and "good enough" are Arthur's.`,
      inputSchema: z.object({
        project: projectRef,
        steps: z
          .array(
            z.object({
              code: z.string().min(1).max(LIMITS.code),
              milestone: z.string().max(LIMITS.milestone).nullable().optional().describe("e.g. Jalon 2, V1"),
              title: z.string().max(LIMITS.stepTitle).optional(),
              good_enough: z.string().max(LIMITS.goodEnough).nullable().optional(),
              budget_minutes: z.number().int().min(LIMITS.budget[0]).max(LIMITS.budget[1]).optional(),
              cut_minutes: z.number().int().max(LIMITS.cutMax).optional(),
              position: z.number().int().optional(),
              status: z.enum(["todo", "dropped"]).optional(),
            }),
          )
          .min(1)
          .max(LIMITS.stepsPerCall),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, steps }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const pr = await projectOr(db, userId, project);
      if ("error" in pr) return failure(pr.error!);
      const r = await saveSteps(db, userId, pr.project.id, steps as StepInput[]);
      if (!r.ok) return failure(r.error);
      const state = await loadState(db, userId, pr.project.id, { itemStatuses: ["open"], messageLimit: 1 });
      const roadmap = groupByMilestone(state!.steps)
        .map((g) => `${g.milestone ?? "(no milestone)"}: ${g.steps.map((s) => `${s.code} ${s.title} [${s.status}, ${fmtMinutes(s.budget_minutes)}/${fmtMinutes(s.cut_minutes)}]`).join(" · ")}`)
        .join("\n");
      return ok(`${r.value.created} created, ${r.value.updated} updated.\n\n${roadmap}\n\n${focusOf(state!, "claude")}`);
    },
  );

  server.registerTool(
    "open_step",
    {
      title: "Open a step (the focus)",
      description: "Open a step. Fails, naming it, if another step of the project is open, and while the contract is a draft.",
      inputSchema: z.object({ project: projectRef, step: stepRef }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, step }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const state = await loadState(db, userId, project, { itemStatuses: ["open"], messageLimit: 1 });
      if (!state) return failure(`No project "${project}".`);
      const s = findStep(state.steps, step);
      if (!s) return failure(`No step "${step}" in ${state.project.slug}. Steps: ${state.steps.map((x) => x.code).join(", ") || "none"}.`);
      const r = await openStep(db, s.id);
      if (!r.ok) return failure(r.error);
      return withFocus(db, userId, state.project.id, `Opened ${s.code} ${s.title}. Good enough: ${s.good_enough ?? "—"}.`);
    },
  );

  server.registerTool(
    "log_work",
    {
      title: "Log time on a step",
      description:
        "The clock sync: minutes spent on a step (default: the open one). Log every ~30 minutes of work and at the end. Source reported = time Arthur says he spent off-chat. Negative minutes correct your own entries of the last day, with a note; anything else is Arthur's to correct.",
      inputSchema: z.object({
        project: projectRef,
        step: stepRef.optional(),
        minutes: z.number().int().min(-LIMITS.workMinutes).max(LIMITS.workMinutes).refine((m) => m !== 0, "Not 0"),
        source: z.enum(["claude_code", "claude_ai", "reported"]),
        note: z.string().max(LIMITS.workNote).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ project, step, minutes, source, note }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const state = await loadState(db, userId, project, { itemStatuses: [], messageLimit: 1 });
      if (!state) return failure(`No project "${project}".`);
      const s = step ? findStep(state.steps, step) : state.open;
      if (!s) return failure(step ? `No step "${step}" in ${state.project.slug}.` : `${state.project.slug} has no open step: name the step, or open one first.`);
      const r = await logWork(db, userId, { stepId: s.id, minutes, source, note });
      if (!r.ok) return failure(r.error);
      return withFocus(db, userId, state.project.id, `Logged ${fmtMinutes(minutes)} on ${s.code} (${source}).`);
    },
  );

  server.registerTool(
    "close_step",
    {
      title: "Close a step",
      description:
        "Close a step (default: the open one) as done, or cut at the cut line with the minimal version. One-line note. Writes a step_closed message with the overrun ratio. next_step opens that step right away, in the same transaction.",
      inputSchema: z.object({
        project: projectRef,
        step: stepRef.optional(),
        outcome: z.enum(["done", "cut"]),
        note: z.string().min(1).max(LIMITS.closeNote).describe("One line: what was delivered, what was left out."),
        next_step: stepRef.optional(),
        surface: surfaceIn.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ project, step, outcome, note, next_step, surface }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const state = await loadState(db, userId, project, { itemStatuses: ["open"], messageLimit: 1 });
      if (!state) return failure(`No project "${project}".`);
      const s = step ? findStep(state.steps, step) : state.open;
      if (!s) return failure(step ? `No step "${step}" in ${state.project.slug}.` : `${state.project.slug} has no open step.`);
      const next = next_step ? findStep(state.steps, next_step) : null;
      if (next_step && !next) return failure(`No step "${next_step}" in ${state.project.slug}. Nothing was closed.`);
      const r = await closeStep(db, { stepId: s.id, outcome, note, nextStepId: next?.id ?? null, surface });
      if (!r.ok) return failure(r.error);
      const left = state.items.filter((i) => i.step_id === s.id && i.status === "open");
      const leftNote = left.length
        ? `\n${left.length} todo${left.length > 1 ? "s" : ""} of ${s.code} still open — tick, drop or park them with save_items (step: null).`
        : "";
      return withFocus(
        db,
        userId,
        state.project.id,
        `Closed ${s.code} ${s.title} as ${outcome}: ${fmtMinutes(r.value.spent)} for a budget of ${fmtMinutes(r.value.budget)}, ratio ${r.value.ratio.toFixed(2)}.${next ? ` Opened ${next.code} ${next.title}.` : ""}${leftNote}`,
      );
    },
  );

  server.registerTool(
    "save_items",
    {
      title: "Add, park, review or tick items",
      description: `Upsert up to ${LIMITS.itemsPerCall} items. Without id: a new item — with a step it is a todo of that step, without one it is parked (one line). With id: update it — step: "<code>" moves a parked item into a step (keep), step: null parks it, status done/dropped closes it (merge = drop with a close_note naming the item it went into). Triage: core, support, logistics. blocks_step: the step a parked item blocks. Items you add are recorded as raised by Claude.`,
      inputSchema: z.object({
        project: projectRef,
        items: z
          .array(
            z.object({
              id: z.string().uuid().optional(),
              title: z.string().max(LIMITS.itemTitle).optional(),
              step: z.string().max(64).nullable().optional().describe("Step code or id; null to park."),
              triage: z.enum(TRIAGES).nullable().optional(),
              blocks_step: z.string().max(64).nullable().optional(),
              status: z.enum(ITEM_STATUSES).optional(),
              close_note: z.string().max(LIMITS.itemNote).optional(),
            }),
          )
          .min(1)
          .max(LIMITS.itemsPerCall),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ project, items }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const state = await loadState(db, userId, project, { itemStatuses: ["open"], messageLimit: 1 });
      if (!state) return failure(`No project "${project}".`);
      const inputs: ItemInput[] = [];
      for (const it of items) {
        const input: ItemInput = { id: it.id, title: it.title, triage: it.triage, status: it.status, close_note: it.close_note };
        if (it.step !== undefined) {
          if (it.step === null) input.step_id = null;
          else {
            const s = findStep(state.steps, it.step);
            if (!s) return failure(`No step "${it.step}" in ${state.project.slug}. Nothing was saved.`);
            input.step_id = s.id;
          }
        }
        if (it.blocks_step !== undefined) {
          if (it.blocks_step === null) input.blocks_step_id = null;
          else {
            const s = findStep(state.steps, it.blocks_step);
            if (!s) return failure(`No step "${it.blocks_step}" in ${state.project.slug}. Nothing was saved.`);
            input.blocks_step_id = s.id;
          }
        }
        inputs.push(input);
      }
      const r = await saveItems(db, userId, state.project.id, inputs);
      if (!r.ok) return failure(r.error);
      const fresh = await loadState(db, userId, state.project.id, { itemStatuses: ["open"], messageLimit: 1 });
      return ok(`${r.value.created} added, ${r.value.updated} updated.\n\n${openItemsText(fresh!)}\n\n${focusOf(fresh!, "claude")}`);
    },
  );

  server.registerTool(
    "set_next_action",
    {
      title: "Set the next action",
      description: "One line + a duration: what to do first next time. Overwrites the previous one; its history stays in the message thread.",
      inputSchema: z.object({
        project: projectRef,
        text: z.string().min(1).max(LIMITS.nextAction),
        minutes: z.number().int().min(1).max(600),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, text, minutes }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const pr = await projectOr(db, userId, project);
      if ("error" in pr) return failure(pr.error!);
      const r = await setNextAction(db, userId, pr.project.id, text, minutes);
      if (!r.ok) return failure(r.error);
      return withFocus(db, userId, pr.project.id, "Next action set.");
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Write to Arthur",
      description:
        "A note on the project's thread in the app. handoff: end of session (≤ 8 lines: where it stands, what was decided, the next action). question: something that needs him — it rings his phone. note: anything else.",
      inputSchema: z.object({
        project: projectRef,
        body: z.string().min(1).max(LIMITS.messageBody).describe("Markdown."),
        kind: z.enum(["handoff", "question", "note"]),
        step: stepRef.optional(),
        surface: surfaceIn,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ project, body, kind, step, surface }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const state = await loadState(db, userId, project, { itemStatuses: [], messageLimit: 1 });
      if (!state) return failure(`No project "${project}".`);
      const s = step ? findStep(state.steps, step) : null;
      if (step && !s) return failure(`No step "${step}" in ${state.project.slug}.`);
      const r = await sendMessage(db, userId, { projectId: state.project.id, body, kind, stepId: s?.id ?? null, surface });
      if (!r.ok) return failure(r.error);
      return withFocus(db, userId, state.project.id, `Sent (${kind}, message ${r.value.id}).`);
    },
  );

  server.registerTool(
    "mark_read",
    {
      title: "Mark Arthur's messages as read",
      description: "Call once you have acted on them, not on sight. Only Arthur's messages can be marked.",
      inputSchema: z.object({ ids: z.array(z.string().uuid()).min(1).max(50) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const r = await markRead(db, userId, ids, { author: "arthur" });
      if (!r.ok) return failure(r.error);
      return ok(`${r.value} message${r.value === 1 ? "" : "s"} marked read${r.value < ids.length ? ` (${ids.length - r.value} were already read, yours, or unknown)` : ""}.`);
    },
  );
}
