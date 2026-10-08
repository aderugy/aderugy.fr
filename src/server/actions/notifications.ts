"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireUser, fail, type ActionResult } from "@/server/auth";
import { accessTokenOf, callEdge } from "@/server/edge";

const b64url = /^[A-Za-z0-9_-]+$/;

const Subscription = z.object({
  endpoint: z.string().url().startsWith("https://").max(2000),
  p256dh: z.string().regex(b64url).min(80).max(100),
  auth: z.string().regex(b64url).min(16).max(32),
  label: z.string().trim().max(120).optional(),
});

/** This browser's push subscription, as `PushSubscription.toJSON()` gives it. */
export async function saveSubscription(input: z.input<typeof Subscription>): Promise<ActionResult> {
  try {
    const sub = Subscription.parse(input);
    const { supabase, user } = await requireUser();
    const { error } = await supabase.from("push_subscriptions").upsert(
      {
        user_id: user.id,
        endpoint: sub.endpoint,
        p256dh: sub.p256dh,
        auth: sub.auth,
        label: sub.label || null,
        last_error: null,
      },
      { onConflict: "user_id,endpoint" },
    );
    if (error) throw error;
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Stop ringing a device — this one, or one listed on the settings page. */
export async function removeSubscription(id: { endpoint: string } | { id: string }): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    let query = supabase.from("push_subscriptions").delete().eq("user_id", user.id);
    query = "id" in id ? query.eq("id", id.id) : query.eq("endpoint", id.endpoint);
    const { error } = await query;
    if (error) throw error;
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

const Prefs = z.object({
  blockReminders: z.boolean(),
  leadMinutes: z.number().int().min(0).max(120),
});

export async function setReminderPrefs(input: z.input<typeof Prefs>): Promise<ActionResult> {
  try {
    const prefs = Prefs.parse(input);
    const { supabase, user } = await requireUser();
    const { error } = await supabase.from("notification_prefs").upsert(
      {
        user_id: user.id,
        block_reminders: prefs.blockReminders,
        lead_minutes: prefs.leadMinutes,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw error;
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Rings every subscribed device once, through the same path as reminders. */
export async function sendTestNotification(): Promise<
  ActionResult | { ok: true; devices: number; delivered: number }
> {
  try {
    const result = (await callEdge("web-push", await accessTokenOf(), { action: "test" })) as {
      devices: number;
      delivered: number;
    };
    refresh();
    if (result.delivered === 0) {
      return { ok: false, error: "No device accepted the notification — see the errors below." };
    }
    return { ok: true, devices: result.devices, delivered: result.delivered };
  } catch (e) {
    return fail(e);
  }
}
