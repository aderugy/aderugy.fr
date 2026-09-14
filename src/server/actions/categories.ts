"use server";

import { revalidatePath } from "next/cache";
import { requireUser, fail, type ActionResult } from "@/server/auth";

export async function createCategory(input: {
  name: string;
  parentId: string | null;
  color: string | null;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const name = input.name.trim();
    if (!name) return { ok: false, error: "Name is required" };

    // Append after the last sibling. `.is(col, null)` and `.eq(col, value)` are
    // different operators, so the parent filter has to branch.
    const siblingQuery = supabase
      .from("categories")
      .select("position")
      .eq("user_id", user.id)
      .order("position", { ascending: false })
      .limit(1);
    const { data: siblings } = await (input.parentId === null
      ? siblingQuery.is("parent_id", null)
      : siblingQuery.eq("parent_id", input.parentId));

    const { error } = await supabase.from("categories").insert({
      user_id: user.id,
      parent_id: input.parentId,
      name,
      color: input.color,
      position: (siblings?.[0]?.position ?? -1) + 1,
    });
    if (error) throw error;

    revalidatePath("/agenda", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function updateCategory(input: {
  id: string;
  name?: string;
  color?: string | null;
  archived?: boolean;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) return { ok: false, error: "Name is required" };
      patch.name = name;
    }
    if (input.color !== undefined) patch.color = input.color;
    if (input.archived !== undefined) patch.archived = input.archived;

    const { error } = await supabase
      .from("categories")
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

/**
 * Deleting cascades to child categories, so the check covers the whole subtree.
 *
 * Since the category is now the label, a row cannot outlive it. The foreign keys
 * already refuse the delete; this asks first so the refusal can say what is in
 * the way instead of surfacing a constraint violation.
 */
export async function deleteCategory(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();

    const { data: usage, error: usageError } = await supabase
      .rpc("category_usage", { p_id: id })
      .single<{ tasks: number; scheduled: number; templates: number }>();
    if (usageError) throw usageError;

    const inUse = [
      usage.tasks > 0 && `${usage.tasks} task${usage.tasks > 1 ? "s" : ""}`,
      usage.scheduled > 0 &&
        `${usage.scheduled} scheduled block${usage.scheduled > 1 ? "s" : ""}`,
      usage.templates > 0 &&
        `${usage.templates} template${usage.templates > 1 ? "s" : ""}`,
    ].filter(Boolean) as string[];

    if (inUse.length > 0) {
      return {
        ok: false,
        error: `Still in use by ${inUse.join(", ")}. Move or delete those first.`,
      };
    }

    const { error } = await supabase
      .from("categories")
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
