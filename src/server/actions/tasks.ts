"use server";

import { revalidatePath } from "next/cache";
import { requireUser, fail, type ActionResult } from "@/server/auth";

export async function createTask(input: {
  title: string;
  categoryId: string | null;
  estimatedMinutes: number;
  priority: number;
  deadline: string | null;
  notes?: string | null;
  splittable?: boolean;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const title = input.title.trim();
    if (!title) return { ok: false, error: "Title is required" };

    const { error } = await supabase.from("tasks").insert({
      user_id: user.id,
      title,
      category_id: input.categoryId,
      estimated_minutes: input.estimatedMinutes,
      priority: input.priority,
      deadline: input.deadline,
      notes: input.notes ?? null,
      splittable: input.splittable ?? true,
    });
    if (error) throw error;

    revalidatePath("/agenda", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function updateTask(input: {
  id: string;
  title?: string;
  categoryId?: string | null;
  estimatedMinutes?: number;
  priority?: number;
  deadline?: string | null;
  notes?: string | null;
  status?: "backlog" | "scheduled" | "done" | "dropped";
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) return { ok: false, error: "Title is required" };
      patch.title = title;
    }
    if (input.categoryId !== undefined) patch.category_id = input.categoryId;
    if (input.estimatedMinutes !== undefined)
      patch.estimated_minutes = input.estimatedMinutes;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.deadline !== undefined) patch.deadline = input.deadline;
    if (input.notes !== undefined) patch.notes = input.notes;
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

    revalidatePath("/agenda", "layout");
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

    revalidatePath("/agenda", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
