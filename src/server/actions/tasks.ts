"use server";

import { refresh } from "next/cache";
import { requireUser, fail, type ActionResult } from "@/server/auth";
import { insertTasks, patchTask, removeTask } from "@/server/agenda/tasks";

// Thin wrappers: the rules live in server/agenda/tasks.ts, shared with the
// Claude connector, so the two can never disagree about what a valid task is.

export async function createTask(input: {
  categoryId: string;
  description: string | null;
  estimatedMinutes: number;
  priority: number;
  deadline: string | null;
  splittable?: boolean;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    // The category is the label, so there is nothing to show without it.
    const result = await insertTasks(supabase, user.id, [input]);
    if (!result.ok) return result;

    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function updateTask(input: {
  id: string;
  categoryId?: string;
  description?: string | null;
  estimatedMinutes?: number;
  priority?: number;
  deadline?: string | null;
  status?: "backlog" | "scheduled" | "done" | "dropped";
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const { id, ...patch } = input;
    const result = await patchTask(supabase, user.id, id, patch);
    if (!result.ok) return result;

    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteTask(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const result = await removeTask(supabase, user.id, id);
    if (!result.ok) return result;

    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
