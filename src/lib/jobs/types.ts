/**
 * /jobs — the internship search. Shapes and rules shared by the pages, the
 * server actions and the Claude connector. Nothing here touches the database.
 */

export const APPLICATION_STATUSES = [
  "to_apply",
  "applied",
  "interviewing",
  "offer",
  "accepted",
  "rejected",
  "withdrawn",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  to_apply: "To apply",
  applied: "Applied",
  interviewing: "Interviewing",
  offer: "Offer",
  accepted: "Accepted",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

/** Still in play. The rest are outcomes. */
export const OPEN_STATUSES: ApplicationStatus[] = ["to_apply", "applied", "interviewing", "offer"];

export function isApplicationStatus(s: string): s is ApplicationStatus {
  return (APPLICATION_STATUSES as readonly string[]).includes(s);
}

export const INTERVIEW_KINDS = ["screening", "hr", "technical", "case", "final", "other"] as const;
export type InterviewKind = (typeof INTERVIEW_KINDS)[number];

export const KIND_LABELS: Record<InterviewKind, string> = {
  screening: "Screening",
  hr: "HR",
  technical: "Technical",
  case: "Case study",
  final: "Final",
  other: "Interview",
};

export const JOB_LIMITS = {
  maxCompany: 120,
  maxRole: 200,
  maxTag: 40,
  maxUrl: 2000,
  maxNotes: 20000,
  maxOffer: 60000,
  maxWithWhom: 300,
  maxLocation: 500,
} as const;

export type Company = {
  id: string;
  name: string;
  website: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type JobTag = {
  id: string;
  name: string;
  color: string | null;
  position: number;
};

export type Application = {
  id: string;
  company_id: string;
  role_title: string;
  offer_url: string | null;
  status: ApplicationStatus;
  notes: string | null;
  applied_on: string | null;
  deadline: string | null;
  offer_md: string | null;
  offer_source: "fetched" | "pasted" | null;
  offer_fetched_at: string | null;
  offer_fetch_error: string | null;
  created_at: string;
  updated_at: string;
};

export type Interview = {
  id: string;
  application_id: string;
  scheduled_block_id: string | null;
  kind: InterviewKind;
  starts_at: string;
  ends_at: string;
  with_whom: string | null;
  location: string | null;
  prep_notes: string | null;
  debrief_notes: string | null;
  created_at: string;
  updated_at: string;
};

export type ApplicationEvent = {
  id: string;
  from_status: ApplicationStatus | null;
  to_status: ApplicationStatus;
  at: string;
};

/** A row of the list: the application with what the list shows about it. */
export type ApplicationSummary = Omit<Application, "offer_md"> & {
  company: Pick<Company, "id" | "name">;
  tags: JobTag[];
  /** The next interview that has not ended yet, if any. */
  next_interview: Pick<Interview, "id" | "kind" | "starts_at" | "ends_at"> | null;
  interview_count: number;
  has_offer_text: boolean;
};

/** A backlog task linked to an application. */
export type LinkedTask = {
  id: string;
  category_id: string;
  description: string | null;
  estimated_minutes: number;
  priority: number;
  deadline: string | null;
  status: "backlog" | "scheduled" | "done" | "dropped";
  ad_hoc: boolean;
};

export type ApplicationDetail = Application & {
  company: Company;
  tags: JobTag[];
  interviews: Interview[];
  events: ApplicationEvent[];
  tasks: LinkedTask[];
};

/** What an interview block carries on the agenda grid. */
export type InterviewOnBlock = {
  id: string;
  application_id: string;
  kind: InterviewKind;
  prep_notes: string | null;
  debrief_notes: string | null;
  company: string;
  role_title: string;
};

/* ---------------------------------------------------------------- rules */

/** The title an interview gets on the agenda, and therefore in Google. */
export function interviewTitle(company: string, kind: InterviewKind): string {
  return kind === "other" ? `Interview · ${company}` : `Interview · ${company} (${KIND_LABELS[kind].toLowerCase()})`;
}

/**
 * No answer for this long after applying reads as silence. Shown as a hint on
 * the list, never stored: a reply next week makes it wrong.
 */
export const SILENCE_DAYS = 21;

export function isSilent(
  app: Pick<Application, "status" | "applied_on" | "updated_at">,
  now: Date,
): boolean {
  if (app.status !== "applied" || !app.applied_on) return false;
  const since = Math.max(Date.parse(app.applied_on), Date.parse(app.updated_at));
  return now.getTime() - since > SILENCE_DAYS * 86_400_000;
}

/** Order of the list: open before closed, then by status, then latest activity. */
export function compareApplications(
  a: Pick<Application, "status" | "updated_at">,
  b: Pick<Application, "status" | "updated_at">,
): number {
  const rank = (s: ApplicationStatus) => APPLICATION_STATUSES.indexOf(s);
  const openA = OPEN_STATUSES.includes(a.status) ? 0 : 1;
  const openB = OPEN_STATUSES.includes(b.status) ? 0 : 1;
  if (openA !== openB) return openA - openB;
  // Further along first among open ones: an offer matters more than a draft.
  if (openA === 0 && a.status !== b.status) return rank(b.status) - rank(a.status);
  return Date.parse(b.updated_at) - Date.parse(a.updated_at);
}

/** A URL worth storing: http(s), trimmed, or null for blank. Throws a sentence otherwise. */
export function cleanUrl(input: string | null | undefined): string | null {
  const t = input?.trim();
  if (!t) return null;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    throw new Error(`"${t}" is not a URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) links can be saved.");
  }
  if (t.length > JOB_LIMITS.maxUrl) throw new Error("That link is too long.");
  return url.toString();
}

/** Markdown keeps its inner formatting; only surrounding blank space goes. */
export function cleanNotes(n: string | null | undefined): string | null {
  const t = n?.replace(/^\s*\n/, "").trimEnd();
  return t ? t : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date, YYYY-MM-DD, or null for blank. Throws a sentence otherwise. */
export function cleanDate(input: string | null | undefined, what = "Date"): string | null {
  const t = input?.trim();
  if (!t) return null;
  if (!ISO_DATE.test(t)) throw new Error(`${what} must be YYYY-MM-DD.`);
  const d = new Date(`${t}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t) {
    throw new Error(`${what} "${t}" is not a real date.`);
  }
  return t;
}
