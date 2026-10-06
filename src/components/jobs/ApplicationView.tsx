"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { NotesEditor } from "@/components/ui/NotesEditor";
import { ErrorLine, StatusBadge, TagChip } from "./bits";
import { InlineText, Section, useAction } from "./controls";
import { InterviewCard, ScheduleInterviewForm } from "./Interviews";
import { LinkedTasks } from "./LinkedTasks";
import { OfferPanel } from "./OfferPanel";
import { fmtDateTime } from "@/lib/jobs/format";
import {
  APPLICATION_STATUSES,
  KIND_LABELS,
  STATUS_LABELS,
  type ApplicationDetail,
  type ApplicationStatus,
  type JobTag,
} from "@/lib/jobs/types";
import type { Category } from "@/lib/types";
import { deleteApplication, updateApplication, updateCompany } from "@/server/actions/jobs";

export function ApplicationView({
  app,
  tags,
  companies,
  categories,
  interviewCategoryId,
  warning,
  now,
}: {
  app: ApplicationDetail;
  tags: JobTag[];
  companies: { id: string; name: string }[];
  categories: Category[];
  interviewCategoryId: string | null;
  warning: string | null;
  now: string;
}) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const tagIds = app.tags.map((t) => t.id);
  const nowMs = Date.parse(now);
  const upcoming = app.interviews.filter((i) => Date.parse(i.ends_at) > nowMs);
  const past = app.interviews.filter((i) => Date.parse(i.ends_at) <= nowMs).reverse();

  const save = (patch: Parameters<typeof updateApplication>[1]) => run(() => updateApplication(app.id, patch));

  const timeline = [
    ...app.events.map((e) => ({
      key: e.id,
      at: e.at,
      muted: false,
      label: `${e.from_status ? `${STATUS_LABELS[e.from_status]} → ` : "Created · "}${STATUS_LABELS[e.to_status]}`,
    })),
    ...app.interviews.map((i) => ({
      key: i.id,
      at: i.starts_at,
      muted: true,
      label: `${KIND_LABELS[i.kind]} interview${i.with_whom ? ` with ${i.with_whom}` : ""}`,
    })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return (
    <main className={`mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 ${pending ? "opacity-80" : ""}`}>
      <Link href="/jobs" className="text-xs text-muted hover:text-foreground">
        ← Applications
      </Link>

      {warning && (
        <p className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {warning}
        </p>
      )}

      <header className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted">
            <Link href={`/jobs/companies/${app.company.id}`} className="font-medium text-foreground hover:text-accent">
              {app.company.name}
            </Link>
            <CompanyPicker
              current={app.company.name}
              companies={companies}
              onPick={(name) => save({ company: { name } })}
            />
          </div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">
            <InlineText value={app.role_title} onSave={(v) => save({ roleTitle: v })} className="w-full" />
          </h1>
          <div className="mt-2 flex flex-wrap gap-1">
            {tags.map((t) => (
              <TagChip
                key={t.id}
                tag={t}
                active={tagIds.includes(t.id)}
                onClick={() =>
                  save({ tagIds: tagIds.includes(t.id) ? tagIds.filter((x) => x !== t.id) : [...tagIds, t.id] })
                }
              />
            ))}
            {tags.length === 0 && (
              <Link href="/jobs/tags" className="text-xs text-muted underline">
                Create tags
              </Link>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={app.status} />
          <select
            aria-label="Status"
            value={app.status}
            onChange={(e) => save({ status: e.target.value as ApplicationStatus })}
            className="rounded border border-line bg-background px-1 py-0.5 text-xs outline-none focus:border-accent"
          >
            {APPLICATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </header>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_1fr_auto_auto_auto_auto]">
        <dt className="text-muted">Offer</dt>
        <dd className="min-w-0 truncate">
          {app.offer_url && (
            <a href={app.offer_url} target="_blank" rel="noreferrer noopener" className="mr-2 text-accent underline">
              open ↗
            </a>
          )}
          <InlineText
            type="url"
            value={app.offer_url ?? ""}
            placeholder="add link"
            onSave={(v) => save({ offerUrl: v || null })}
            className="max-w-full text-muted"
          />
        </dd>
        <dt className="text-muted">Applied</dt>
        <dd>
          <input
            type="date"
            value={app.applied_on ?? ""}
            onChange={(e) => save({ appliedOn: e.target.value || null })}
            className="bg-transparent outline-none"
          />
        </dd>
        <dt className="text-muted">Apply before</dt>
        <dd>
          <input
            type="date"
            value={app.deadline ?? ""}
            onChange={(e) => save({ deadline: e.target.value || null })}
            className="bg-transparent outline-none"
          />
        </dd>
      </dl>
      <ErrorLine error={error} />

      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Notes">
            <NotesEditor
              value={app.notes}
              onSave={(notes) => save({ notes })}
              placeholder={"Why this one, contacts, what they said…\n- [ ] send CV\n- [ ] follow up"}
              startClosed
            />
          </Section>

          <OfferPanel app={app} />

          <Section
            title={`About ${app.company.name}`}
            aside={
              <Link href={`/jobs/companies/${app.company.id}`} className="text-xs text-muted hover:text-foreground">
                company page →
              </Link>
            }
          >
            <NotesEditor
              value={app.company.notes}
              onSave={(notes) => run(() => updateCompany(app.company.id, { notes }))}
              placeholder="Shared by every application to this company: contacts, culture, what you learnt…"
              addLabel="Add company notes"
              startClosed
            />
          </Section>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Section
            title="Interviews"
            id="interviews"
            aside={
              !scheduling && (
                <button onClick={() => setScheduling(true)} className="text-xs text-accent hover:underline">
                  + Schedule
                </button>
              )
            }
          >
            {scheduling && (
              <ScheduleInterviewForm
                applicationId={app.id}
                categories={categories}
                defaultCategoryId={interviewCategoryId}
                onDone={() => setScheduling(false)}
              />
            )}
            {app.interviews.length === 0 && !scheduling && (
              <p className="text-xs text-muted">None yet. Scheduling one puts it on the agenda and in Google.</p>
            )}
            <div className="flex flex-col gap-3">
              {[...upcoming, ...past].map((i) => (
                <InterviewCard
                  key={i.id}
                  interview={i}
                  past={Date.parse(i.ends_at) <= nowMs}
                  categories={categories}
                  defaultCategoryId={interviewCategoryId}
                />
              ))}
            </div>
          </Section>

          <LinkedTasks app={app} categories={categories} now={now} />

          <Section title="Timeline">
            <ol className="space-y-1 text-xs">
              {timeline.map((t) => (
                <li key={t.key} className={`flex gap-2 ${t.muted ? "text-muted" : ""}`}>
                  <span className="w-28 shrink-0 text-muted tabular-nums">{fmtDateTime(t.at)}</span>
                  <span>{t.label}</span>
                </li>
              ))}
            </ol>
          </Section>

          <div className="text-right text-xs">
            {confirmDelete ? (
              <span className="inline-flex items-center gap-2">
                <span className="text-muted">
                  Delete this application{app.interviews.length ? " and its interviews (agenda included)" : ""}?
                </span>
                <button onClick={() => setConfirmDelete(false)} className="text-muted hover:text-foreground">
                  Keep
                </button>
                <button
                  onClick={() => run(() => deleteApplication(app.id), () => router.push("/jobs"))}
                  className="rounded bg-red-600 px-2 py-0.5 font-medium text-white"
                >
                  Delete
                </button>
              </span>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="text-muted hover:text-red-500">
                Delete application
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

/** Move the application to another company — typed, with the existing ones suggested. */
function CompanyPicker({
  current,
  companies,
  onPick,
}: {
  current: string;
  companies: { id: string; name: string }[];
  onPick: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-muted hover:text-foreground">
        change
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setOpen(false);
        if (draft.trim() && draft.trim().toLowerCase() !== current.toLowerCase()) onPick(draft.trim());
      }}
      className="inline-flex gap-1"
    >
      <input
        autoFocus
        list="jobs-company-move"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        placeholder="Company"
        className="rounded border border-line bg-background px-1 text-xs outline-none focus:border-accent"
      />
      <datalist id="jobs-company-move">
        {companies.map((c) => (
          <option key={c.id} value={c.name} />
        ))}
      </datalist>
      <button type="submit" className="text-xs text-accent">
        Move
      </button>
    </form>
  );
}
