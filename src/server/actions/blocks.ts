"use server";

import { refresh } from "next/cache";
import { requireUser, fail, type ActionResult } from "@/server/auth";

export async function createBlock(input: {
  name: string;
  defaultMinutes: number;
  defaultCategoryId: string | null;
  color: string | null;
  preferredDaypart: "morning" | "afternoon" | "evening" | null;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const name = input.name.trim();
    if (!name) return { ok: false, error: "Name is required" };

    const { error } = await supabase.from("blocks").insert({
      user_id: user.id,
      name,
      default_minutes: input.defaultMinutes,
      default_category_id: input.defaultCategoryId,
      color: input.color,
      preferred_daypart: input.preferredDaypart,
    });
    if (error) throw error;

    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function updateBlock(input: {
  id: string;
  name?: string;
  defaultMinutes?: number;
  defaultCategoryId?: string | null;
  color?: string | null;
  preferredDaypart?: "morning" | "afternoon" | "evening" | null;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.defaultMinutes !== undefined)
      patch.default_minutes = input.defaultMinutes;
    if (input.defaultCategoryId !== undefined)
      patch.default_category_id = input.defaultCategoryId;
    if (input.color !== undefined) patch.color = input.color;
    if (input.preferredDaypart !== undefined)
      patch.preferred_daypart = input.preferredDaypart;

    const { error } = await supabase
      .from("blocks")
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

export async function deleteBlock(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const { error } = await supabase
      .from("blocks")
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

export async function addBlockItem(input: {
  blockId: string;
  label: string;
  estimatedMinutes: number;
  categoryId: string | null;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const label = input.label.trim();
    if (!label) return { ok: false, error: "Label is required" };

    const { data: last } = await supabase
      .from("block_items")
      .select("position")
      .eq("block_id", input.blockId)
      .eq("user_id", user.id)
      .order("position", { ascending: false })
      .limit(1);

    const { error } = await supabase.from("block_items").insert({
      user_id: user.id,
      block_id: input.blockId,
      label,
      estimated_minutes: input.estimatedMinutes,
      category_id: input.categoryId,
      position: (last?.[0]?.position ?? -1) + 1,
    });
    if (error) throw error;

    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteBlockItem(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const { error } = await supabase
      .from("block_items")
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
