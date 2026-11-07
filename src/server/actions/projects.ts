"use server";

import { refresh } from "next/cache";
import { requireUser, fail, type ActionResult } from "@/server/auth";
import type { ItemStatus, ProjectStatus, StepStatus, Triage, WorkEntry } from "@/lib/projects/types";
import {
  closeStep as closeStepRow,
  deleteItem,
  deleteMessage,
  deleteProject as deleteProjectRow,
  deleteStep as deleteStepRow,
  loadWork,
  logWork as logWorkRow,
  markClaudeMessagesRead,
  openStep as openStepRow,
  saveItems,
  saveProject,
  saveSteps,
  sendMessage as sendMessageRow,
  setNextAction as setNextActionRow,
  type ProjectFields,
  type StepInput,
} from "@/server/projects/data";

// Thin wrappers: the rules live in server/projects/data.ts and in migration
// 0030, shared with the Claude connector.

type Res<T> = { ok: true; value: T } | { ok: false; error: string };

async function act(fn: (ctx: Awaited<ReturnType<typeof requireUser>>) => Promise<ActionResult>): Promise<ActionResult> {
  try {
    const ctx = await requireUser();
    const r = await fn(ctx);
    if (r.ok) refresh();
    return r;
  } catch (e) {
    return fail(e);
  }
}

export async function createProject(slug: string, name: string): Promise<Res<string>> {
  try {
    const { supabase, user } = await requireUser();
    const r = await saveProject(supabase, user.id, slug, { name });
    if (!r.ok) return r;
    if (!r.value.created) return { ok: false, error: `${r.value.project.slug} already exists.` };
    refresh();
    return { ok: true, value: r.value.project.slug };
  } catch (e) {
    return fail(e) as Res<string>;
  }
}

export async function updateProject(id: string, fields: ProjectFields): Promise<ActionResult> {
  return act(async ({ supabase, user }) => {
    const r = await saveProject(supabase, user.id, id, fields);
    return r.ok ? { ok: true } : r;
  });
}

export async function setProjectStatus(id: string, status: ProjectStatus): Promise<ActionResult> {
  return updateProject(id, { status });
}

export async function removeProject(id: string): Promise<ActionResult> {
  return act(({ supabase, user }) => deleteProjectRow(supabase, user.id, id));
}

export async function setNextAction(projectId: string, text: string, minutes: number | null): Promise<ActionResult> {
  return act(({ supabase, user }) => setNextActionRow(supabase, user.id, projectId, text, minutes));
}

/* ----------------------------------------------------------------- steps */

export async function saveStep(projectId: string, step: StepInput): Promise<ActionResult> {
  return act(async ({ supabase, user }) => {
    const r = await saveSteps(supabase, user.id, projectId, [step]);
    return r.ok ? { ok: true } : r;
  });
}

/** Rename a step's code: the upsert is by code, so this one goes by id. */
export async function renameStepCode(stepId: string, code: string): Promise<ActionResult> {
  return act(async ({ supabase, user }) => {
    const c = code.trim();
    if (!c || c.length > 12) return { ok: false, error: "A step code is 1–12 characters." };
    const { error } = await supabase.from("research_steps").update({ code: c }).eq("user_id", user.id).eq("id", stepId);
    if (error) return { ok: false, error: error.code === "23505" ? "That code is already used in this project." : error.message };
    return { ok: true };
  });
}

export async function setStepStatus(stepId: string, status: StepStatus): Promise<ActionResult> {
  return act(async ({ supabase, user }) => {
    if (status === "open") return openStepRow(supabase, stepId);
    const { error } = await supabase.from("research_steps").update({ status }).eq("user_id", user.id).eq("id", stepId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });
}

export async function openStep(stepId: string): Promise<ActionResult> {
  return act(({ supabase }) => openStepRow(supabase, stepId));
}

/**
 * Close the open step. `parkTodos` parks its open todos first, marked as
 * blocking the next step (the close dialog offers it).
 */
export async function closeStep(input: {
  projectId: string;
  stepId: string;
  outcome: "done" | "cut";
  note: string;
  nextStepId: string | null;
  parkTodos: boolean;
  /** The step parked todos block: the next one in the plan. */
  blocksStepId: string | null;
}): Promise<ActionResult> {
  return act(async ({ supabase, user }) => {
    if (input.parkTodos) {
      const { data, error } = await supabase
        .from("research_items")
        .select("id")
        .eq("user_id", user.id)
        .eq("step_id", input.stepId)
        .eq("status", "open");
      if (error) throw error;
      if (data?.length) {
        const r = await saveItems(
          supabase,
          user.id,
          input.projectId,
          data.map((d) => ({ id: d.id as string, step_id: null, blocks_step_id: input.blocksStepId })),
        );
        if (!r.ok) return r;
      }
    }
    const r = await closeStepRow(supabase, {
      stepId: input.stepId,
      outcome: input.outcome,
      note: input.note,
      nextStepId: input.nextStepId,
      surface: "app",
    });
    return r.ok ? { ok: true } : r;
  });
}

export async function removeStep(stepId: string): Promise<ActionResult> {
  return act(({ supabase, user }) => deleteStepRow(supabase, user.id, stepId));
}

/* ------------------------------------------------------------------ work */

export async function logWork(stepId: string, minutes: number, note?: string, reported = false): Promise<ActionResult> {
  return act(({ supabase, user }) =>
    logWorkRow(supabase, user.id, { stepId, minutes, source: reported ? "reported" : "app", note }),
  );
}

export async function stepWork(stepId: string): Promise<Res<WorkEntry[]>> {
  try {
    const { supabase, user } = await requireUser();
    return { ok: true, value: await loadWork(supabase, user.id, stepId) };
  } catch (e) {
    return fail(e) as Res<WorkEntry[]>;
  }
}

/* ----------------------------------------------------------------- items */

export async function saveItem(
  projectId: string,
  item: {
    id?: string;
    title?: string;
    step_id?: string | null;
    triage?: Triage | null;
    blocks_step_id?: string | null;
    status?: ItemStatus;
    close_note?: string | null;
    position?: number;
  },
): Promise<ActionResult> {
  return act(async ({ supabase, user }) => {
    const r = await saveItems(supabase, user.id, projectId, [item]);
    return r.ok ? { ok: true } : r;
  });
}

export async function removeItem(itemId: string): Promise<ActionResult> {
  return act(({ supabase, user }) => deleteItem(supabase, user.id, itemId));
}

/* -------------------------------------------------------------- messages */

export async function sendMessage(projectId: string, body: string, stepId: string | null): Promise<ActionResult> {
  return act(async ({ supabase, user }) => {
    const r = await sendMessageRow(supabase, user.id, { projectId, body, kind: "note", stepId, surface: "app" });
    return r.ok ? { ok: true } : r;
  });
}

export async function removeMessage(messageId: string): Promise<ActionResult> {
  return act(({ supabase, user }) => deleteMessage(supabase, user.id, messageId));
}

/** Arthur has the project open: Claude's messages are read. No refresh — the page already shows them. */
export async function markClaudeRead(projectId: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    await markClaudeMessagesRead(supabase, user.id, projectId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
