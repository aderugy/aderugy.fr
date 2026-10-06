import "server-only";
import { z } from "zod";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import { isUuid } from "@/lib/agenda/backlog";
import { fmtDateTime } from "@/lib/jobs/format";
import {
  APPLICATION_STATUSES,
  JOB_LIMITS,
  KIND_LABELS,
  STATUS_LABELS,
  type ApplicationDetail,
  type ApplicationStatus,
  type ApplicationSummary,
  type Interview,
} from "@/lib/jobs/types";
import {
  createApplication,
  getApplicationDetail,
  getCompany,
  getInterview,
  listApplications,
  loadCompanies,
  loadTags,
  patchApplication,
  patchCompany,
  patchInterview,
  refreshOffer,
  resolveTagRefs,
  setOfferText,
} from "@/server/jobs/data";
import { loadCategoryPaths } from "@/server/agenda/tasks";
import { callerOf } from "./auth";

/**
 * /jobs as MCP tools, on the same connector as the backlog.
 *
 * Same rules as backlog-tools.ts: every call goes through server/jobs/data.ts
 * with the caller's own token, so RLS and the OAuth-client restrictions of
 * migration 0017 apply — Claude may read everything, create and edit
 * applications and companies, write interview *prep*, and nothing else.
 * Scheduling, moving or deleting interviews, the debrief, tags and history
 * stay with Arthur in the app.
 */

export const JOBS_INSTRUCTIONS = `Arthur's internship search (aderugy.fr/jobs): 6-month end-of-studies internship from February 2027.

How the data works:
- An application is one job offer at one company: role title, link, status, Markdown notes, and several tags for the type of job (e.g. quant, research, DS/ML, CIFRE). Tags are Arthur's; list_job_tags shows them, and they cannot be created from here.
- Companies are shared by every application to them and carry their own Markdown notes (contacts, research). Prefer company notes for anything true of the company, application notes for this offer.
- Status: to_apply, applied, interviewing, offer, accepted, rejected, withdrawn. Moving to "applied" fills the applied date. Every change is kept in the application's timeline.
- The offer is saved as Markdown when the link is added, because postings disappear. get_application returns it. If it is missing or the site refused the server (LinkedIn often does), read the page another way and store it with set_offer_text.
- Interviews are scheduled by Arthur in the app (they go on his agenda). Each has two notes: prep and debrief. You may write the prep only (write_interview_prep); the debrief is his.

Preparing an interview: get_application (offer, notes, company notes, past debriefs), research the company and the role, then write_interview_prep with a concise, skimmable Markdown sheet — what they look for, how his experience maps to it, likely questions with answer outlines, questions to ask them. Prep tasks can go on his backlog with create_tasks.`;

/* ------------------------------------------------------------- shapes */

const applicationId = z.string().uuid().describe("Application id, from list_applications.");
const statusIn = z.enum(APPLICATION_STATUSES);
const dateIn = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").describe("A date, YYYY-MM-DD.");
const markdown = (max: number, what: string) => z.string().max(max).describe(`${what} in Markdown.`);

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function summaryLine(a: ApplicationSummary): string {
  const bits = [
    `${a.company.name} — ${a.role_title}`,
    STATUS_LABELS[a.status],
  ];
  if (a.tags.length) bits.push(a.tags.map((t) => t.name).join(", "));
  if (a.applied_on) bits.push(`applied ${a.applied_on}`);
  if (a.deadline && a.status === "to_apply") bits.push(`apply by ${a.deadline}`);
  if (a.next_interview) {
    bits.push(`next: ${KIND_LABELS[a.next_interview.kind]} ${fmtDateTime(a.next_interview.starts_at)} (interview ${a.next_interview.id})`);
  }
  if (!a.has_offer_text) bits.push(a.offer_url ? "offer text not saved" : "no offer link");
  return `- ${bits.join(" · ")} (id ${a.id})`;
}

function interviewBlock(i: Interview, now: number): string {
  const when = `${fmtDateTime(i.starts_at)}–${fmtDateTime(i.ends_at).split(" ").pop()}`;
  const head = `### ${KIND_LABELS[i.kind]} — ${when}${Date.parse(i.ends_at) < now ? " (past)" : ""} (interview ${i.id})`;
  const lines = [head];
  if (i.with_whom) lines.push(`With: ${i.with_whom}`);
  if (i.location) lines.push(`Where: ${i.location}`);
  lines.push(`On the agenda: ${i.scheduled_block_id ? "yes" : "no"}`);
  lines.push("", "#### Prep", i.prep_notes ?? "_(empty)_", "", "#### Debrief", i.debrief_notes ?? "_(empty)_");
  return lines.join("\n");
}

function detailText(a: ApplicationDetail, categoryPaths: Map<string, string>): string {
  const now = Date.now();
  const out = [
    `# ${a.company.name} — ${a.role_title}`,
    `id ${a.id} · status ${a.status} (${STATUS_LABELS[a.status]}) · tags: ${a.tags.map((t) => t.name).join(", ") || "none"}`,
    `offer link: ${a.offer_url ?? "none"} · applied on: ${a.applied_on ?? "—"} · apply before: ${a.deadline ?? "—"}`,
    "",
    "## Application notes",
    a.notes ?? "_(empty)_",
    "",
    `## Company notes (${a.company.name}, company id ${a.company.id})`,
    a.company.website ? `Website: ${a.company.website}` : "",
    a.company.notes ?? "_(empty)_",
    "",
    "## Interviews",
    a.interviews.length ? a.interviews.map((i) => interviewBlock(i, now)).join("\n\n") : "_(none scheduled)_",
    "",
    "## Linked backlog tasks",
    a.tasks.length
      ? a.tasks
          .map((t) => `- [${t.status === "done" ? "x" : " "}] ${categoryPaths.get(t.category_id) ?? "?"} — ${t.description ?? ""} (${t.estimated_minutes} min, ${t.status}, task ${t.id})`)
          .join("\n")
      : "_(none)_",
    "",
    "## Timeline",
    a.events.map((e) => `- ${fmtDateTime(e.at)}: ${e.from_status ? `${e.from_status} → ` : "created as "}${e.to_status}`).join("\n"),
    "",
    "## Offer (saved copy)",
    a.offer_md
      ? `_${a.offer_source === "pasted" ? "pasted" : "fetched"} ${a.offer_fetched_at ? fmtDateTime(a.offer_fetched_at) : ""}_\n\n${a.offer_md}`
      : `_(not saved${a.offer_fetch_error ? `: ${a.offer_fetch_error}` : ""})_`,
  ];
  return out.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n");
}

/* -------------------------------------------------------------- tools */

export function registerJobsTools(server: McpServer) {
  server.registerTool(
    "list_applications",
    {
      title: "List job applications",
      description:
        "Arthur's internship applications, open ones first (furthest along first), then closed ones. One line each: company, role, status, tags, dates, next interview.",
      inputSchema: z.object({
        status: z.array(statusIn).optional().describe("Statuses to include. Default: all."),
        tags: z.array(z.string()).optional().describe("Keep applications carrying every one of these tags (names or ids)."),
        company: z.string().optional().describe("Company name or id."),
        query: z.string().max(200).optional().describe("Text to look for in company names and role titles."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      let tagIds: string[] | undefined;
      if (input.tags?.length) {
        const r = resolveTagRefs(await loadTags(db, userId), input.tags);
        if (!r.ok) return failure(r.error);
        tagIds = r.ids;
      }
      let companyId: string | undefined;
      if (input.company) {
        const companies = await loadCompanies(db, userId);
        const c = companies.find(
          (x) => x.id === input.company || x.name.toLowerCase() === input.company!.trim().toLowerCase(),
        );
        if (!c) return ok(`No company "${input.company}". Companies: ${companies.map((x) => x.name).join(", ") || "none yet"}.`);
        companyId = c.id;
      }
      const rows = await listApplications(db, userId, {
        statuses: input.status as ApplicationStatus[] | undefined,
        tagIds,
        companyId,
        query: input.query,
      });
      return ok(rows.length ? `${rows.length} application${rows.length > 1 ? "s" : ""}:\n${rows.map(summaryLine).join("\n")}` : "No application matches.");
    },
  );

  server.registerTool(
    "get_application",
    {
      title: "Read one application in full",
      description:
        "Everything about one application: its notes, the company's notes, the saved offer text, every interview with its prep and debrief notes, linked backlog tasks and the status timeline. Start here to prepare an interview.",
      inputSchema: z.object({ id: applicationId }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const [detail, categories] = await Promise.all([getApplicationDetail(db, userId, id), loadCategoryPaths(db, userId)]);
      if (!detail) return failure(`No application with id ${id}.`);
      return ok(detailText(detail, new Map(categories.map((c) => [c.id, c.path]))));
    },
  );

  server.registerTool(
    "list_interviews",
    {
      title: "List interviews",
      description: "Interviews across all applications, soonest first. By default only those not over yet.",
      inputSchema: z.object({
        include_past: z.boolean().optional().describe("Also list interviews that are over, most recent first after the upcoming ones."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ include_past }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const { data, error } = await db
        .from("interviews")
        .select("id, application_id, kind, starts_at, ends_at, with_whom, prep_notes, debrief_notes, applications(role_title, companies(name))")
        .eq("user_id", userId)
        .order("starts_at");
      if (error) throw error;
      const now = Date.now();
      type Row = Interview & { applications: { role_title: string; companies: { name: string } | { name: string }[] | null } | null };
      const rows = (data ?? []) as unknown as Row[];
      const upcoming = rows.filter((r) => Date.parse(r.ends_at) >= now);
      const past = include_past ? rows.filter((r) => Date.parse(r.ends_at) < now).reverse() : [];
      const line = (r: Row) => {
        const c = r.applications?.companies;
        const company = (Array.isArray(c) ? c[0]?.name : c?.name) ?? "?";
        return `- ${fmtDateTime(r.starts_at)} · ${KIND_LABELS[r.kind]} · ${company} — ${r.applications?.role_title ?? ""}${r.with_whom ? ` · with ${r.with_whom}` : ""} · prep ${r.prep_notes ? "written" : "empty"}${Date.parse(r.ends_at) < now ? ` · debrief ${r.debrief_notes ? "written" : "empty"}` : ""} (interview ${r.id}, application ${r.application_id})`;
      };
      const text = [
        upcoming.length ? `Upcoming:\n${upcoming.map(line).join("\n")}` : "No upcoming interview.",
        past.length ? `Past:\n${past.map(line).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return ok(text);
    },
  );

  server.registerTool(
    "create_application",
    {
      title: "Add a job application",
      description:
        "Record a new application. Give the offer link when there is one: the page is fetched and saved, and the role title and company are taken from it when not given. If the site refuses, the application is still created and the error says so — then pass the text with set_offer_text. The company is matched by name (any case) or created.",
      inputSchema: z.object({
        company: z.string().max(JOB_LIMITS.maxCompany).optional().describe("Company name. Optional when the offer page names it."),
        role_title: z.string().max(JOB_LIMITS.maxRole).optional().describe("Role title. Optional when the offer page names it."),
        offer_url: z.string().url().max(JOB_LIMITS.maxUrl).optional(),
        offer_text: markdown(JOB_LIMITS.maxOffer, "The offer's text, when you already have it").optional(),
        status: statusIn.optional().describe('Default "to_apply".'),
        tags: z.array(z.string()).optional().describe("Tag names or ids, from list_job_tags."),
        notes: markdown(JOB_LIMITS.maxNotes, "Application notes").optional(),
        deadline: dateIn.optional().describe("Apply before this date."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      let tagIds: string[] = [];
      if (input.tags?.length) {
        const r = resolveTagRefs(await loadTags(db, userId), input.tags);
        if (!r.ok) return failure(`Nothing was created. ${r.error}`);
        tagIds = r.ids;
      }
      const result = await createApplication(db, userId, {
        company: { name: input.company ?? "" },
        roleTitle: input.role_title ?? "",
        offerUrl: input.offer_url ?? null,
        status: input.status,
        notes: input.notes ?? null,
        deadline: input.deadline ?? null,
        tagIds,
        offer: input.offer_text ? { markdown: input.offer_text, source: "pasted" } : null,
        fetch: !input.offer_text,
      });
      if (!result.ok) {
        const hint = !input.company || !input.role_title ? " Give the company and the role title explicitly." : "";
        return failure(`Nothing was created. ${result.error}${hint}`);
      }
      const { application, offerError } = result.value;
      const company = await getCompany(db, userId, application.company_id);
      return ok(
        [
          `Created: ${company?.name ?? "?"} — ${application.role_title} (${STATUS_LABELS[application.status]}) (id ${application.id}).`,
          application.offer_md
            ? `Offer saved (${application.offer_md.length} characters).`
            : offerError
              ? `The offer was not saved: ${offerError}`
              : "No offer text saved.",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "update_application",
    {
      title: "Edit an application",
      description:
        "Change an application's status, notes, role title, link, dates, tags or company. Only the fields given change; null clears notes, link and dates. Notes are replaced as a whole — read them first with get_application and send the full new text. Tags given replace the whole set.",
      inputSchema: z.object({
        id: applicationId,
        status: statusIn.optional(),
        notes: markdown(JOB_LIMITS.maxNotes, "Application notes").nullable().optional(),
        role_title: z.string().max(JOB_LIMITS.maxRole).optional(),
        offer_url: z.string().url().max(JOB_LIMITS.maxUrl).nullable().optional(),
        applied_on: dateIn.nullable().optional(),
        deadline: dateIn.nullable().optional(),
        tags: z.array(z.string()).optional().describe("The full set of tags (names or ids)."),
        company: z.string().max(JOB_LIMITS.maxCompany).optional().describe("Move to this company (name, matched or created)."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      let tagIds: string[] | undefined;
      if (input.tags) {
        const r = resolveTagRefs(await loadTags(db, userId), input.tags);
        if (!r.ok) return failure(`Nothing was changed. ${r.error}`);
        tagIds = r.ids;
      }
      const result = await patchApplication(db, userId, input.id, {
        status: input.status,
        notes: input.notes,
        roleTitle: input.role_title,
        offerUrl: input.offer_url,
        appliedOn: input.applied_on,
        deadline: input.deadline,
        tagIds,
        company: input.company !== undefined ? { name: input.company } : undefined,
      });
      if (!result.ok) return failure(result.error);
      const a = result.value;
      return ok(
        `Updated: ${a.role_title} — ${STATUS_LABELS[a.status]} (id ${a.id}).${input.company ? " Agenda blocks of its interviews keep the old company name until Arthur edits them in the app." : ""}`,
      );
    },
  );

  server.registerTool(
    "refresh_offer",
    {
      title: "Fetch the offer again",
      description: "Fetch the application's offer link again and replace the saved copy. A failure keeps the copy already saved.",
      inputSchema: z.object({ id: applicationId }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const r = await refreshOffer(db, userId, id);
      if (!r.ok) return failure(r.error);
      if (r.value.error) return failure(`Not refreshed: ${r.value.error}`);
      return ok(`Offer saved again (${r.value.application.offer_md?.length ?? 0} characters).`);
    },
  );

  server.registerTool(
    "set_offer_text",
    {
      title: "Store the offer's text",
      description:
        "Save the offer's text on an application, replacing any saved copy — for sites that refuse the server (read the page another way first), or to clean up a fetched copy. Keep the offer's own words; Markdown headings and lists are fine.",
      inputSchema: z.object({
        id: applicationId,
        markdown: markdown(JOB_LIMITS.maxOffer, "The offer's full text"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, markdown: md }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const r = await setOfferText(db, userId, id, md);
      if (!r.ok) return failure(r.error);
      return ok(`Offer text saved (${r.value.offer_md?.length ?? 0} characters).`);
    },
  );

  server.registerTool(
    "list_companies",
    {
      title: "List companies",
      description: "Companies Arthur has applications with, with their number of applications and whether they have notes.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const companies = await loadCompanies(db, userId);
      return ok(
        companies.length
          ? companies
              .map((c) => `- ${c.name} · ${c.application_count} application${c.application_count === 1 ? "" : "s"}${c.notes ? " · has notes" : ""}${c.website ? ` · ${c.website}` : ""} (id ${c.id})`)
              .join("\n")
          : "No company yet.",
      );
    },
  );

  server.registerTool(
    "update_company",
    {
      title: "Edit a company's notes or website",
      description:
        "Replace a company's Markdown notes (shared by all its applications) or set its website. Read the current notes first (get_application shows them) and send the full new text: notes are replaced as a whole.",
      inputSchema: z.object({
        company: z.string().describe("Company id or exact name."),
        notes: markdown(JOB_LIMITS.maxNotes, "Company notes").nullable().optional(),
        website: z.string().url().max(JOB_LIMITS.maxUrl).nullable().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      let id: string | null = null;
      if (isUuid(input.company)) {
        id = (await getCompany(db, userId, input.company))?.id ?? null;
      } else {
        const companies = await loadCompanies(db, userId);
        id = companies.find((c) => c.name.toLowerCase() === input.company.trim().toLowerCase())?.id ?? null;
        if (!id) return failure(`No company "${input.company}". Companies: ${companies.map((c) => c.name).join(", ") || "none yet"}.`);
      }
      if (!id) return failure(`No company with id ${input.company}.`);
      const r = await patchCompany(db, userId, id, { notes: input.notes, website: input.website });
      if (!r.ok) return failure(r.error);
      return ok(`Updated ${r.value.name}.`);
    },
  );

  server.registerTool(
    "list_job_tags",
    {
      title: "List job tags",
      description: "The tags for the type of job (quant, research, DS/ML, CIFRE…). Arthur manages them in the app; they cannot be created from here.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const tags = await loadTags(db, userId);
      return ok(tags.length ? tags.map((t) => `- ${t.name} (id ${t.id})`).join("\n") : "No tags yet. Arthur creates them in /jobs/tags.");
    },
  );

  server.registerTool(
    "write_interview_prep",
    {
      title: "Write an interview's prep notes",
      description:
        "Replace the prep notes of one interview with a Markdown prep sheet. This is the only interview field Claude may write; the debrief is Arthur's. If prep notes exist, read them first (get_application) and keep what Arthur added.",
      inputSchema: z.object({
        interview_id: z.string().uuid().describe("Interview id, from get_application or list_interviews."),
        markdown: markdown(JOB_LIMITS.maxNotes, "The prep sheet"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ interview_id, markdown: md }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const interview = await getInterview(db, userId, interview_id);
      if (!interview) return failure(`No interview with id ${interview_id}.`);
      const r = await patchInterview(db, userId, interview_id, { prepNotes: md });
      if (!r.ok) return failure(r.error);
      return ok(`Prep saved on the ${KIND_LABELS[interview.kind].toLowerCase()} interview of ${fmtDateTime(interview.starts_at)}. Arthur sees it on the application page and in the agenda block.`);
    },
  );
}
