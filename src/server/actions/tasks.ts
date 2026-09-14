"use server";

import { refresh } from "next/cache";
import { requireUser, fail, type ActionResult } from "@/server/auth";

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
    if (!input.categoryId) return { ok: false, error: "Pick a category" };

    const { error } = await supabase.from("tasks").insert({
      user_id: user.id,
      category_id: input.categoryId,
      description: input.description?.trim() || null,
      estimated_minutes: input.estimatedMinutes,
      priority: input.priority,
      deadline: input.deadline,
      splittable: input.splittable ?? true,
    });
    if (error) throw error;

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
    const patch: Record<string, unknown> = {};

    if (input.categoryId !== undefined) {
      if (!input.categoryId) return { ok: false, error: "Pick a category" };
      patch.category_id = input.categoryId;
    }
    if (input.description !== undefined) {
      patch.description = input.description?.trim() || null;
    }
    if (input.estimatedMinutes !== undefined) {
      patch.estimated_minutes = input.estimatedMinutes;
    }
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.deadline !== undefined) patch.deadline = input.deadline;
    if (input.status !== undefined) {
      patch.status = input.status;
      patch.completed_at = input.status === "done" ? new Date().toISOString() : null;
    }

    const { error } = await supabase
      .from("tasks")
      .update(patch)
      .eq("id", input.id)
      .eq("user_id", user.id);
    if (error) throw error;

    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteTask(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const { error } = await supabase
      .from("tasks")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) throw error;

    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
