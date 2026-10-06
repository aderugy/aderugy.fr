"use server";

import { refresh } from "next/cache";
import { requireUser, fail, type ActionResult } from "@/server/auth";
import { queuePush } from "@/server/push";
import { insertTasks } from "@/server/agenda/tasks";
import { fetchOffer } from "@/server/jobs/fetch-offer";
import {
  createApplication as createApplicationRow,
  insertTag,
  patchApplication,
  patchCompany,
  patchInterview,
  patchTag,
  refreshOffer as refreshOfferRow,
  removeCompany,
  removeTag,
  setOfferText,
  type ApplicationPatch,
  type InterviewPatch,
  type NewApplication,
} from "@/server/jobs/data";
import {
  moveInterview as moveInterviewRow,
  putInterviewOnAgenda as putOnAgenda,
  removeApplication,
  removeInterview,
  retitleInterviewBlock,
  scheduleInterview as scheduleInterviewRow,
  type NewInterview,
} from "@/server/jobs/agenda";

// Thin wrappers: the rules live in server/jobs/, shared with the Claude
// connector where it is allowed to act.

type IdResult = { ok: true; id: string; warning?: string } | { ok: false; error: string };

/** Fetch an offer without saving anything: the new-application form prefills from it. */
export async function previewOffer(
  url: string,
): Promise<{ ok: true; title: string | null; company: string | null; markdown: string } | { ok: false; error: string }> {
  try {
    await requireUser();
    const r = await fetchOffer(url);
    if (!r.ok) return r;
    return { ok: true, title: r.offer.title, company: r.offer.company, markdown: r.offer.markdown };
  } catch (e) {
    return fail(e) as { ok: false; error: string };
  }
}

export async function createApplication(input: NewApplication): Promise<IdResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await createApplicationRow(supabase, user.id, input);
    if (!r.ok) return r;
    refresh();
    return {
      ok: true,
      id: r.value.application.id,
      warning: r.value.offerError ? `Saved, but the offer was not: ${r.value.offerError}` : undefined,
    };
  } catch (e) {
    return fail(e) as IdResult;
  }
}

export async function updateApplication(id: string, patch: ApplicationPatch): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await patchApplication(supabase, user.id, id, patch);
    if (!r.ok) return r;
    if (patch.company !== undefined) await retitleInterviewsOf(supabase, user.id, { applicationId: id });
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteApplication(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await removeApplication(supabase, user.id, id);
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function refreshOffer(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await refreshOfferRow(supabase, user.id, id);
    if (!r.ok) return r;
    refresh();
    return r.value.error ? { ok: false, error: r.value.error } : { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function saveOfferText(id: string, markdown: string | null): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await setOfferText(supabase, user.id, id, markdown);
    if (!r.ok) return r;
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/* ------------------------------------------------------------- companies */

async function retitleInterviewsOf(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  userId: string,
  of: { applicationId: string } | { companyId: string },
) {
  let q = supabase
    .from("interviews")
    .select("id, applications!inner(company_id)")
    .eq("user_id", userId)
    .not("scheduled_block_id", "is", null);
  q = "applicationId" in of ? q.eq("application_id", of.applicationId) : q.eq("applications.company_id", of.companyId);
  const { data, error } = await q;
  if (error) throw error;
  for (const row of data ?? []) await retitleInterviewBlock(supabase, userId, row.id as string);
  if ((data ?? []).length) await queuePush(supabase);
}

export async function updateCompany(
  id: string,
  patch: { name?: string; website?: string | null; notes?: string | null },
): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await patchCompany(supabase, user.id, id, patch);
    if (!r.ok) return r;
    if (patch.name !== undefined) await retitleInterviewsOf(supabase, user.id, { companyId: id });
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteCompany(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await removeCompany(supabase, user.id, id);
    if (!r.ok) return r;
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/* ------------------------------------------------------------------ tags */

export async function createTag(input: { name: string; color: string | null }): Promise<IdResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await insertTag(supabase, user.id, input);
    if (!r.ok) return r;
    refresh();
    return { ok: true, id: r.value.id };
  } catch (e) {
    return fail(e) as IdResult;
  }
}

export async function updateTag(
  id: string,
  patch: { name?: string; color?: string | null; position?: number },
): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await patchTag(supabase, user.id, id, patch);
    if (!r.ok) return r;
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteTag(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await removeTag(supabase, user.id, id);
    if (!r.ok) return r;
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/* ------------------------------------------------------------ interviews */

export async function scheduleInterview(input: NewInterview): Promise<IdResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await scheduleInterviewRow(supabase, user.id, input);
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true, id: r.value.id };
  } catch (e) {
    return fail(e) as IdResult;
  }
}

export async function updateInterview(id: string, patch: InterviewPatch): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await patchInterview(supabase, user.id, id, patch);
    if (!r.ok) return r;
    if (patch.kind !== undefined) {
      await retitleInterviewBlock(supabase, user.id, id);
      await queuePush(supabase);
    }
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function moveInterview(id: string, startsAt: string, endsAt: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await moveInterviewRow(supabase, user.id, id, startsAt, endsAt);
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function putInterviewOnAgenda(id: string, categoryId: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await putOnAgenda(supabase, user.id, id, categoryId);
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteInterview(id: string): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await removeInterview(supabase, user.id, id);
    if (!r.ok) return r;
    await queuePush(supabase);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/* ----------------------------------------------------------------- tasks */

/** A backlog task that belongs to an application (prep, follow-up…). */
export async function createApplicationTask(input: {
  applicationId: string;
  categoryId: string;
  description: string | null;
  estimatedMinutes: number;
  priority: number;
  /** YYYY-MM-DD or null. Stored like the backlog's: midnight UTC. */
  deadline: string | null;
}): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    const r = await insertTasks(supabase, user.id, [
      {
        categoryId: input.categoryId,
        description: input.description,
        estimatedMinutes: input.estimatedMinutes,
        priority: input.priority,
        deadline: input.deadline ? new Date(`${input.deadline}T00:00:00Z`).toISOString() : null,
        applicationId: input.applicationId,
      },
    ]);
    if (!r.ok) return r;
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
