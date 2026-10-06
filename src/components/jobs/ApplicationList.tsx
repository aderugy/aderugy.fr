"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { ErrorLine, StatusBadge, TagChip } from "./bits";
import { NewApplicationForm } from "./NewApplicationForm";
import { fmtDate, fmtDateTime } from "@/lib/jobs/format";
import {
  APPLICATION_STATUSES,
  KIND_LABELS,
  OPEN_STATUSES,
  STATUS_LABELS,
  isSilent,
  type ApplicationStatus,
  type ApplicationSummary,
  type JobTag,
} from "@/lib/jobs/types";
import { updateApplication } from "@/server/actions/jobs";

type StatusFilter = "open" | "all" | ApplicationStatus;

export function ApplicationList({
  applications,
  tags,
  companies,
  now,
}: {
  applications: ApplicationSummary[];
  tags: JobTag[];
  companies: { id: string; name: string }[];
  now: string;
}) {
  const [status, setStatus] = useState<StatusFilter>("open");
  const [tagIds, setTagIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(applications.length === 0);

  const counts = useMemo(() => {
    const c = new Map<StatusFilter, number>([["all", applications.length]]);
    for (const a of applications) {
      c.set(a.status, (c.get(a.status) ?? 0) + 1);
      if (OPEN_STATUSES.includes(a.status)) c.set("open", (c.get("open") ?? 0) + 1);
    }
    return c;
  }, [applications]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return applications.filter(
      (a) =>
        (status === "all" || (status === "open" ? OPEN_STATUSES.includes(a.status) : a.status === status)) &&
        [...tagIds].every((id) => a.tags.some((t) => t.id === id)) &&
        (!q || a.role_title.toLowerCase().includes(q) || a.company.name.toLowerCase().includes(q)),
    );
  }, [applications, status, tagIds, query]);

  const filters: StatusFilter[] = ["open", ...APPLICATION_STATUSES, "all"];
  const nowDate = new Date(now);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Applications</h1>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search company or role…"
          className="ml-auto w-full rounded border border-line bg-surface px-2 py-1 text-sm outline-none focus:border-accent sm:w-56"
        />
        <button
          onClick={() => setCreating((v) => !v)}
          className="rounded bg-accent px-3 py-1 text-sm font-medium text-white"
        >
          {creating ? "Close" : "New application"}
        </button>
      </div>

      {creating && (
        <div className="mt-4">
          <NewApplicationForm tags={tags} companies={companies} onDone={() => setCreating(false)} />
        </div>
      )}

      <div className="mt-5 flex gap-1 overflow-x-auto pb-1 text-xs [scrollbar-width:none]">
        {filters.map((f) => {
          const n = counts.get(f) ?? 0;
          if (n === 0 && f !== "open" && f !== "all" && f !== status) return null;
          return (
            <button
              key={f}
              onClick={() => setStatus(f)}
              className={`shrink-0 rounded-full border px-2.5 py-0.5 ${
                status === f ? "border-accent bg-accent/10 text-foreground" : "border-line text-muted hover:text-foreground"
              }`}
            >
              {f === "open" ? "Open" : f === "all" ? "All" : STATUS_LABELS[f]}{" "}
              <span className="tabular-nums opacity-70">{n}</span>
            </button>
          );
        })}
      </div>

      {tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {tags.map((t) => (
            <TagChip
              key={t.id}
              tag={t}
              active={tagIds.has(t.id)}
              title={tagIds.has(t.id) ? "Stop filtering by this tag" : "Only applications with this tag"}
              onClick={() =>
                setTagIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(t.id)) next.delete(t.id);
                  else next.add(t.id);
                  return next;
                })
              }
            />
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <p className="mt-10 text-center text-sm text-muted">
          {applications.length === 0 ? "No application yet. Start with the link to an offer." : "Nothing matches these filters."}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
          {shown.map((a) => (
            <Row key={a.id} app={a} silent={isSilent(a, nowDate)} />
          ))}
        </ul>
      )}
    </main>
  );
}

function Row({ app, silent }: { app: ApplicationSummary; silent: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <li className={`flex flex-col gap-1.5 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4 ${pending ? "opacity-60" : ""}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Link href={`/jobs/${app.id}`} className="truncate text-sm font-medium hover:text-accent">
            {app.company.name}
          </Link>
          <span className="truncate text-sm text-muted">{app.role_title}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted">
          {app.tags.map((t) => (
            <TagChip key={t.id} tag={t} />
          ))}
          {app.next_interview && (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-300">
              {KIND_LABELS[app.next_interview.kind]} · {fmtDateTime(app.next_interview.starts_at)}
            </span>
          )}
          {app.deadline && app.status === "to_apply" && <span>apply by {fmtDate(app.deadline)}</span>}
          {app.applied_on && app.status !== "to_apply" && <span>applied {fmtDate(app.applied_on)}</span>}
          {silent && <span className="text-amber-600">no news for 3 weeks — follow up?</span>}
          {!app.has_offer_text && app.offer_url && <span title={app.offer_fetch_error ?? ""}>offer not saved</span>}
        </div>
        <ErrorLine error={error} />
      </div>
      <label className="flex items-center gap-2">
        <StatusBadge status={app.status} />
        <select
          aria-label="Change status"
          value={app.status}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.value as ApplicationStatus;
            setError(null);
            startTransition(async () => {
              const r = await updateApplication(app.id, { status: next });
              if (!r.ok) setError(r.error);
            });
          }}
          className="rounded border border-line bg-background px-1 py-0.5 text-xs text-muted outline-none focus:border-accent"
        >
          {APPLICATION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
    </li>
  );
}
