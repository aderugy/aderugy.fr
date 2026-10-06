import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Result } from "@/server/agenda/tasks";
import { fetchOffer } from "./fetch-offer";
import {
  APPLICATION_STATUSES,
  JOB_LIMITS,
  cleanDate,
  cleanNotes,
  cleanUrl,
  compareApplications,
  isApplicationStatus,
  type Application,
  type ApplicationDetail,
  type ApplicationEvent,
  type ApplicationStatus,
  type ApplicationSummary,
  type Company,
  type Interview,
  type InterviewKind,
  type JobTag,
  type LinkedTask,
} from "@/lib/jobs/types";

/**
 * /jobs persistence shared by the pages' server actions and the Claude
 * connector, on the model of server/agenda/tasks.ts: every function takes the
 * client to act through (cookie-bound for the UI, bearer-token for Claude),
 * both run as the user under RLS, and the OAuth-client rules of migration 0017
 * apply to the connector without anything here having to know.
 *
 * Throws on database errors; returns `{ ok: false }` for anything the caller
 * should show as a sentence.
 *
 * Interviews' time and their place on the agenda live in ./agenda.ts: that
 * part writes scheduled blocks, which only the browser may do.
 */

export const APPLICATION_COLUMNS =
  "id, company_id, role_title, offer_url, status, notes, applied_on, deadline, offer_md, offer_source, offer_fetched_at, offer_fetch_error, created_at, updated_at";
const LIST_COLUMNS =
  "id, company_id, role_title, offer_url, status, notes, applied_on, deadline, offer_source, offer_fetched_at, offer_fetch_error, created_at, updated_at";
export const COMPANY_COLUMNS = "id, name, website, notes, created_at, updated_at";
export const TAG_COLUMNS = "id, name, color, position";
export const INTERVIEW_COLUMNS =
  "id, application_id, scheduled_block_id, kind, starts_at, ends_at, with_whom, location, prep_notes, debrief_notes, created_at, updated_at";

/** Run a validation that throws a sentence; turn it into a Result. */
function attempt<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function tooLong(value: string | null, max: number, what: string): string | null {
  return value && value.length > max ? `${what}: at most ${max} characters.` : null;
}

function cleanText(s: string | null | undefined): string | null {
  const t = s?.trim().replace(/\s+/g, " ");
  return t ? t : null;
}

/** Escape LIKE wildcards so a name is matched literally. */
function likeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function pgCode(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

/** PostgREST hands a to-one embed back as an object, a to-many one as an array. */
function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/* ------------------------------------------------------------- companies */

export type CompanyWithCount = Company & { application_count: number };

export async function loadCompanies(db: SupabaseClient, userId: string): Promise<CompanyWithCount[]> {
  const { data, error } = await db
    .from("companies")
    .select(`${COMPANY_COLUMNS}, applications(count)`)
    .eq("user_id", userId)
    .order("name");
  if (error) throw error;
  return (data ?? []).map((row) => {
    const { applications, ...company } = row as Company & { applications: { count: number }[] };
    return { ...company, application_count: applications?.[0]?.count ?? 0 };
  });
}

export async function getCompany(db: SupabaseClient, userId: string, id: string): Promise<Company | null> {
  const { data, error } = await db
    .from("companies")
    .select(COMPANY_COLUMNS)
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as Company | null) ?? null;
}

async function findCompanyByName(db: SupabaseClient, userId: string, name: string): Promise<Company | null> {
  const { data, error } = await db
    .from("companies")
    .select(COMPANY_COLUMNS)
    .eq("user_id", userId)
    .ilike("name", likeLiteral(name))
    .limit(1);
  if (error) throw error;
  return ((data ?? [])[0] as Company | undefined) ?? null;
}

function checkCompanyName(name: string | null): string | null {
  if (!name) return "Give the company a name.";
  return tooLong(name, JOB_LIMITS.maxCompany, "A company name");
}

/** The company with this name (any case), created if it does not exist yet. */
export async function ensureCompany(
  db: SupabaseClient,
  userId: string,
  rawName: string,
): Promise<Result<Company>> {
  const name = cleanText(rawName);
  const problem = checkCompanyName(name);
  if (problem) return { ok: false, error: problem };

  const existing = await findCompanyByName(db, userId, name!);
  if (existing) return { ok: true, value: existing };

  const { data, error } = await db
    .from("companies")
    .insert({ user_id: userId, name })
    .select(COMPANY_COLUMNS)
    .single();
  if (error) {
    // Created by a concurrent request between the read and the insert.
    if (pgCode(error) === "23505") {
      const again = await findCompanyByName(db, userId, name!);
      if (again) return { ok: true, value: again };
    }
    throw error;
  }
  return { ok: true, value: data as Company };
}

export async function patchCompany(
  db: SupabaseClient,
  userId: string,
  id: string,
  input: { name?: string; website?: string | null; notes?: string | null },
): Promise<Result<Company>> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = cleanText(input.name);
    const problem = checkCompanyName(name);
    if (problem) return { ok: false, error: problem };
    patch.name = name;
  }
  if (input.website !== undefined) {
    const r = attempt(() => cleanUrl(input.website));
    if (!r.ok) return r;
    patch.website = r.value;
  }
  if (input.notes !== undefined) {
    const notes = cleanNotes(input.notes);
    const problem = tooLong(notes, JOB_LIMITS.maxNotes, "Notes");
    if (problem) return { ok: false, error: problem };
    patch.notes = notes;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "Nothing to change." };

  const { data, error } = await db
    .from("companies")
    .update(patch)
    .eq("user_id", userId)
    .eq("id", id)
    .select(COMPANY_COLUMNS)
    .maybeSingle();
  if (error) {
    if (pgCode(error) === "23505") return { ok: false, error: `A company named "${patch.name}" already exists.` };
    throw error;
  }
  if (!data) return { ok: false, error: "No such company." };
  return { ok: true, value: data as Company };
}

export async function removeCompany(db: SupabaseClient, userId: string, id: string): Promise<Result> {
  const { error, count } = await db
    .from("companies")
    .delete({ count: "exact" })
    .eq("user_id", userId)
    .eq("id", id);
  if (error) {
    if (pgCode(error) === "23503") {
      return { ok: false, error: "This company has applications. Delete them first, or keep the company." };
    }
    throw error;
  }
  if (!count) return { ok: false, error: "No such company." };
  return { ok: true };
}

/* ------------------------------------------------------------------ tags */

export async function loadTags(db: SupabaseClient, userId: string): Promise<JobTag[]> {
  const { data, error } = await db
    .from("job_tags")
    .select(TAG_COLUMNS)
    .eq("user_id", userId)
    .order("position")
    .order("name");
  if (error) throw error;
  return (data ?? []) as JobTag[];
}

/** Tags named by id or by name (any case). Unknown names are an error listing the real ones. */
export function resolveTagRefs(
  tags: JobTag[],
  refs: string[],
): { ok: true; ids: string[] } | { ok: false; error: string } {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const ref of refs) {
    const r = ref.trim().toLowerCase();
    const tag = tags.find((t) => t.id === ref || t.name.toLowerCase() === r);
    if (tag) ids.push(tag.id);
    else unknown.push(ref);
  }
  if (unknown.length) {
    const known = tags.length ? `Tags: ${tags.map((t) => `"${t.name}"`).join(", ")}.` : "There are no tags yet.";
    return { ok: false, error: `Unknown tag${unknown.length > 1 ? "s" : ""} ${unknown.map((u) => `"${u}"`).join(", ")}. ${known}` };
  }
  return { ok: true, ids: [...new Set(ids)] };
}

function checkTagName(name: string | null): string | null {
  if (!name) return "Give the tag a name.";
  return tooLong(name, JOB_LIMITS.maxTag, "A tag name");
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

export async function insertTag(
  db: SupabaseClient,
  userId: string,
  input: { name: string; color: string | null },
): Promise<Result<JobTag>> {
  const name = cleanText(input.name);
  const problem = checkTagName(name);
  if (problem) return { ok: false, error: problem };
  if (input.color && !COLOR.test(input.color)) return { ok: false, error: "Colour must be #rrggbb." };

  const { data: last } = await db
    .from("job_tags")
    .select("position")
    .eq("user_id", userId)
    .order("position", { ascending: false })
    .limit(1);
  const position = ((last ?? [])[0]?.position ?? -1) + 1;

  const { data, error } = await db
    .from("job_tags")
    .insert({ user_id: userId, name, color: input.color, position })
    .select(TAG_COLUMNS)
    .single();
  if (error) {
    if (pgCode(error) === "23505") return { ok: false, error: `A tag named "${name}" already exists.` };
    throw error;
  }
  return { ok: true, value: data as JobTag };
}

export async function patchTag(
  db: SupabaseClient,
  userId: string,
  id: string,
  input: { name?: string; color?: string | null; position?: number },
): Promise<Result> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = cleanText(input.name);
    const problem = checkTagName(name);
    if (problem) return { ok: false, error: problem };
    patch.name = name;
  }
  if (input.color !== undefined) {
    if (input.color && !COLOR.test(input.color)) return { ok: false, error: "Colour must be #rrggbb." };
    patch.color = input.color;
  }
  if (input.position !== undefined) patch.position = input.position;
  if (Object.keys(patch).length === 0) return { ok: false, error: "Nothing to change." };

  const { error, count } = await db
    .from("job_tags")
    .update(patch, { count: "exact" })
    .eq("user_id", userId)
    .eq("id", id);
  if (error) {
    if (pgCode(error) === "23505") return { ok: false, error: `A tag named "${patch.name}" already exists.` };
    throw error;
  }
  if (!count) return { ok: false, error: "No such tag." };
  return { ok: true };
}

export async function removeTag(db: SupabaseClient, userId: string, id: string): Promise<Result> {
  const { error } = await db.from("job_tags").delete().eq("user_id", userId).eq("id", id);
  if (error) throw error;
  return { ok: true };
}

/** Make an application's tags exactly this set. */
export async function setApplicationTags(
  db: SupabaseClient,
  userId: string,
  applicationId: string,
  tagIds: string[],
): Promise<void> {
  const wanted = new Set(tagIds);
  const { data, error } = await db
    .from("application_tags")
    .select("tag_id")
    .eq("user_id", userId)
    .eq("application_id", applicationId);
  if (error) throw error;
  const current = new Set((data ?? []).map((r) => r.tag_id as string));

  const gone = [...current].filter((id) => !wanted.has(id));
  const added = [...wanted].filter((id) => !current.has(id));
  if (gone.length) {
    const { error: e } = await db
      .from("application_tags")
      .delete()
      .eq("user_id", userId)
      .eq("application_id", applicationId)
      .in("tag_id", gone);
    if (e) throw e;
  }
  if (added.length) {
    const { error: e } = await db
      .from("application_tags")
      .insert(added.map((tag_id) => ({ user_id: userId, application_id: applicationId, tag_id })));
    if (e) throw e;
  }
}

/* ---------------------------------------------------------- applications */

export type NewApplication = {
  /** An existing company's id, or a name to find or create. */
  company: { id: string } | { name: string };
  roleTitle: string;
  offerUrl?: string | null;
  status?: ApplicationStatus;
  notes?: string | null;
  appliedOn?: string | null;
  deadline?: string | null;
  tagIds?: string[];
  /** Offer text already in hand (a preview, or pasted). Otherwise the URL is fetched when `fetch` is set. */
  offer?: { markdown: string; source: "fetched" | "pasted" } | null;
  fetch?: boolean;
};

export async function createApplication(
  db: SupabaseClient,
  userId: string,
  input: NewApplication,
): Promise<Result<{ application: Application; offerError: string | null }>> {
  const fields = attempt(() => ({
    offerUrl: cleanUrl(input.offerUrl),
    appliedOn: cleanDate(input.appliedOn, "Applied on"),
    deadline: cleanDate(input.deadline, "Deadline"),
  }));
  if (!fields.ok) return fields;
  const { offerUrl, appliedOn, deadline } = fields.value;

  // Fetch first: the offer may name the role and the company.
  let offer = input.offer ?? null;
  let offerError: string | null = null;
  let roleTitle = cleanText(input.roleTitle);
  let company = input.company;
  if (!offer && offerUrl && input.fetch) {
    const fetched = await fetchOffer(offerUrl);
    if (fetched.ok) {
      offer = { markdown: fetched.offer.markdown, source: "fetched" };
      roleTitle ??= cleanText(fetched.offer.title);
      if ("name" in company && !cleanText(company.name) && fetched.offer.company) {
        company = { name: fetched.offer.company };
      }
    } else {
      offerError = fetched.error;
    }
  }

  if (!roleTitle) return { ok: false, error: "Give the role a title." };
  const problem =
    tooLong(roleTitle, JOB_LIMITS.maxRole, "A role title") ??
    tooLong(cleanNotes(input.notes), JOB_LIMITS.maxNotes, "Notes") ??
    (offer ? tooLong(offer.markdown, JOB_LIMITS.maxOffer, "The offer text") : null);
  if (problem) return { ok: false, error: problem };
  const status = input.status ?? "to_apply";
  if (!isApplicationStatus(status)) return { ok: false, error: `Status must be one of ${APPLICATION_STATUSES.join(", ")}.` };

  let companyId: string;
  if ("id" in company) {
    const found = await getCompany(db, userId, company.id);
    if (!found) return { ok: false, error: "No such company." };
    companyId = found.id;
  } else {
    const ensured = await ensureCompany(db, userId, company.name);
    if (!ensured.ok) return ensured;
    companyId = ensured.value.id;
  }

  const { data, error } = await db
    .from("applications")
    .insert({
      user_id: userId,
      company_id: companyId,
      role_title: roleTitle,
      offer_url: offerUrl,
      status,
      notes: cleanNotes(input.notes),
      applied_on: appliedOn,
      deadline,
      offer_md: offer ? cleanNotes(offer.markdown) : null,
      offer_source: offer ? offer.source : null,
      offer_fetched_at: offer ? new Date().toISOString() : null,
      offer_fetch_error: offerError,
    })
    .select(APPLICATION_COLUMNS)
    .single();
  if (error) throw error;
  const application = data as Application;

  if (input.tagIds?.length) await setApplicationTags(db, userId, application.id, input.tagIds);
  return { ok: true, value: { application, offerError } };
}

export type ApplicationPatch = {
  company?: { id: string } | { name: string };
  roleTitle?: string;
  offerUrl?: string | null;
  status?: ApplicationStatus;
  notes?: string | null;
  appliedOn?: string | null;
  deadline?: string | null;
  tagIds?: string[];
};

export async function patchApplication(
  db: SupabaseClient,
  userId: string,
  id: string,
  input: ApplicationPatch,
): Promise<Result<Application>> {
  const patch: Record<string, unknown> = {};

  if (input.roleTitle !== undefined) {
    const role = cleanText(input.roleTitle);
    if (!role) return { ok: false, error: "Give the role a title." };
    const problem = tooLong(role, JOB_LIMITS.maxRole, "A role title");
    if (problem) return { ok: false, error: problem };
    patch.role_title = role;
  }
  if (input.status !== undefined) {
    if (!isApplicationStatus(input.status)) {
      return { ok: false, error: `Status must be one of ${APPLICATION_STATUSES.join(", ")}.` };
    }
    patch.status = input.status;
  }
  if (input.notes !== undefined) {
    const notes = cleanNotes(input.notes);
    const problem = tooLong(notes, JOB_LIMITS.maxNotes, "Notes");
    if (problem) return { ok: false, error: problem };
    patch.notes = notes;
  }
  const fields = attempt(() => ({
    offer_url: input.offerUrl !== undefined ? cleanUrl(input.offerUrl) : undefined,
    applied_on: input.appliedOn !== undefined ? cleanDate(input.appliedOn, "Applied on") : undefined,
    deadline: input.deadline !== undefined ? cleanDate(input.deadline, "Deadline") : undefined,
  }));
  if (!fields.ok) return fields;
  for (const [k, v] of Object.entries(fields.value)) if (v !== undefined) patch[k] = v;

  if (input.company !== undefined) {
    if ("id" in input.company) {
      const found = await getCompany(db, userId, input.company.id);
      if (!found) return { ok: false, error: "No such company." };
      patch.company_id = found.id;
    } else {
      const ensured = await ensureCompany(db, userId, input.company.name);
      if (!ensured.ok) return ensured;
      patch.company_id = ensured.value.id;
    }
  }

  if (Object.keys(patch).length === 0 && input.tagIds === undefined) {
    return { ok: false, error: "Nothing to change." };
  }

  let row: Application | null;
  if (Object.keys(patch).length) {
    const { data, error } = await db
      .from("applications")
      .update(patch)
      .eq("user_id", userId)
      .eq("id", id)
      .select(APPLICATION_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    row = data as Application | null;
  } else {
    row = await getApplication(db, userId, id);
  }
  if (!row) return { ok: false, error: "No such application." };

  if (input.tagIds !== undefined) await setApplicationTags(db, userId, id, input.tagIds);
  return { ok: true, value: row };
}

export async function getApplication(db: SupabaseClient, userId: string, id: string): Promise<Application | null> {
  const { data, error } = await db
    .from("applications")
    .select(APPLICATION_COLUMNS)
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as Application | null) ?? null;
}

/** Fetch the offer again from its link. A failure keeps the copy already saved. */
export async function refreshOffer(
  db: SupabaseClient,
  userId: string,
  id: string,
): Promise<Result<{ application: Application; error: string | null }>> {
  const app = await getApplication(db, userId, id);
  if (!app) return { ok: false, error: "No such application." };
  if (!app.offer_url) return { ok: false, error: "This application has no offer link to fetch." };

  const fetched = await fetchOffer(app.offer_url);
  const patch = fetched.ok
    ? {
        offer_md: fetched.offer.markdown,
        offer_source: "fetched",
        offer_fetched_at: new Date().toISOString(),
        offer_fetch_error: null,
      }
    : { offer_fetch_error: fetched.error };

  const { data, error } = await db
    .from("applications")
    .update(patch)
    .eq("user_id", userId)
    .eq("id", id)
    .select(APPLICATION_COLUMNS)
    .single();
  if (error) throw error;
  return { ok: true, value: { application: data as Application, error: fetched.ok ? null : fetched.error } };
}

/** Store the offer's text as given (pasted, or read in a browser). Null clears it. */
export async function setOfferText(
  db: SupabaseClient,
  userId: string,
  id: string,
  markdown: string | null,
): Promise<Result<Application>> {
  const md = cleanNotes(markdown);
  const problem = tooLong(md, JOB_LIMITS.maxOffer, "The offer text");
  if (problem) return { ok: false, error: problem };

  const { data, error } = await db
    .from("applications")
    .update({
      offer_md: md,
      offer_source: md ? "pasted" : null,
      offer_fetched_at: md ? new Date().toISOString() : null,
      offer_fetch_error: null,
    })
    .eq("user_id", userId)
    .eq("id", id)
    .select(APPLICATION_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, error: "No such application." };
  return { ok: true, value: data as Application };
}

export type ApplicationFilters = {
  statuses?: ApplicationStatus[];
  /** Keep applications carrying every one of these tags. */
  tagIds?: string[];
  companyId?: string;
  /** Case-insensitive match on the company name or the role title. */
  query?: string;
};

type ListRow = Omit<Application, "offer_md"> & {
  companies: Pick<Company, "id" | "name"> | Pick<Company, "id" | "name">[] | null;
  application_tags: { job_tags: JobTag | JobTag[] | null }[];
  interviews: Pick<Interview, "id" | "kind" | "starts_at" | "ends_at">[];
};

export async function listApplications(
  db: SupabaseClient,
  userId: string,
  filters: ApplicationFilters = {},
): Promise<ApplicationSummary[]> {
  let q = db
    .from("applications")
    .select(
      `${LIST_COLUMNS}, companies(id, name), application_tags(job_tags(${TAG_COLUMNS})), interviews(id, kind, starts_at, ends_at)`,
    )
    .eq("user_id", userId);
  if (filters.statuses?.length) q = q.in("status", filters.statuses);
  if (filters.companyId) q = q.eq("company_id", filters.companyId);

  const { data, error } = await q.order("updated_at", { ascending: false }).limit(1000);
  if (error) throw error;

  const now = Date.now();
  const query = filters.query?.trim().toLowerCase();
  const rows = ((data ?? []) as unknown as ListRow[]).map((row): ApplicationSummary => {
    const { companies, application_tags, interviews, ...app } = row;
    const tags = application_tags
      .map((l) => one(l.job_tags))
      .filter((t): t is JobTag => !!t)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    const upcoming = interviews
      .filter((i) => Date.parse(i.ends_at) > now)
      .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    return {
      ...app,
      company: one(companies) ?? { id: app.company_id, name: "(unknown company)" },
      tags,
      next_interview: upcoming[0] ?? null,
      interview_count: interviews.length,
      has_offer_text: !!app.offer_fetched_at,
    };
  });

  return rows
    .filter((r) => !filters.tagIds?.length || filters.tagIds.every((id) => r.tags.some((t) => t.id === id)))
    .filter(
      (r) =>
        !query ||
        r.role_title.toLowerCase().includes(query) ||
        r.company.name.toLowerCase().includes(query),
    )
    .sort(compareApplications);
}

type DetailRow = Application & {
  companies: Company | Company[] | null;
  application_tags: { job_tags: JobTag | JobTag[] | null }[];
  interviews: Interview[];
  application_events: ApplicationEvent[];
};

export async function getApplicationDetail(
  db: SupabaseClient,
  userId: string,
  id: string,
): Promise<ApplicationDetail | null> {
  const [appRes, tasksRes] = await Promise.all([
    db
      .from("applications")
      .select(
        `${APPLICATION_COLUMNS}, companies(${COMPANY_COLUMNS}), application_tags(job_tags(${TAG_COLUMNS})), interviews(${INTERVIEW_COLUMNS}), application_events(id, from_status, to_status, at)`,
      )
      .eq("user_id", userId)
      .eq("id", id)
      .maybeSingle(),
    db
      .from("tasks")
      .select("id, category_id, description, estimated_minutes, priority, deadline, status, ad_hoc")
      .eq("user_id", userId)
      .eq("application_id", id)
      .order("created_at"),
  ]);
  if (appRes.error) throw appRes.error;
  if (tasksRes.error) throw tasksRes.error;
  if (!appRes.data) return null;

  const { companies, application_tags, interviews, application_events, ...app } =
    appRes.data as unknown as DetailRow;
  const company = one(companies);
  if (!company) return null;
  return {
    ...app,
    company,
    tags: application_tags
      .map((l) => one(l.job_tags))
      .filter((t): t is JobTag => !!t)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    interviews: [...interviews].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)),
    events: [...application_events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    // The interview's own block task is shown as the interview, not as a task.
    tasks: ((tasksRes.data ?? []) as LinkedTask[]).filter((t) => !t.ad_hoc),
  };
}

/* ------------------------------------------------------------ interviews */

export async function getInterview(db: SupabaseClient, userId: string, id: string): Promise<Interview | null> {
  const { data, error } = await db
    .from("interviews")
    .select(INTERVIEW_COLUMNS)
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as Interview | null) ?? null;
}

export type InterviewPatch = {
  kind?: InterviewKind;
  withWhom?: string | null;
  location?: string | null;
  prepNotes?: string | null;
  debriefNotes?: string | null;
};

/**
 * The interview's own fields. Its time is not here: moving an interview moves
 * its block, which is ./agenda.ts. A connected app may only send `prepNotes`
 * (the database refuses anything else from it — migration 0017).
 */
export async function patchInterview(
  db: SupabaseClient,
  userId: string,
  id: string,
  input: InterviewPatch,
): Promise<Result<Interview>> {
  const patch: Record<string, unknown> = {};
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.withWhom !== undefined) {
    const v = cleanText(input.withWhom);
    const problem = tooLong(v, JOB_LIMITS.maxWithWhom, "Who it is with");
    if (problem) return { ok: false, error: problem };
    patch.with_whom = v;
  }
  if (input.location !== undefined) {
    const v = cleanText(input.location);
    const problem = tooLong(v, JOB_LIMITS.maxLocation, "The place");
    if (problem) return { ok: false, error: problem };
    patch.location = v;
  }
  for (const [key, column] of [
    ["prepNotes", "prep_notes"],
    ["debriefNotes", "debrief_notes"],
  ] as const) {
    if (input[key] === undefined) continue;
    const v = cleanNotes(input[key]);
    const problem = tooLong(v, JOB_LIMITS.maxNotes, "Notes");
    if (problem) return { ok: false, error: problem };
    patch[column] = v;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "Nothing to change." };

  const { data, error } = await db
    .from("interviews")
    .update(patch)
    .eq("user_id", userId)
    .eq("id", id)
    .select(INTERVIEW_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, error: "No such interview." };
  return { ok: true, value: data as Interview };
}
