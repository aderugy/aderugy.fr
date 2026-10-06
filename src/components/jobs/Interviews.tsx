"use client";

import Link from "next/link";
import { useState } from "react";
import { CategoryPicker } from "@/components/agenda/CategoryPicker";
import { NotesEditor } from "@/components/ui/NotesEditor";
import { ErrorLine } from "./bits";
import { InlineText, useAction } from "./controls";
import { APP_TIMEZONE, fmtDateTime, fmtTimeOnly, fromLocalInput, toLocalInput } from "@/lib/jobs/format";
import { INTERVIEW_KINDS, KIND_LABELS, type Interview, type InterviewKind } from "@/lib/jobs/types";
import { isoWeekStartInTimeZone } from "@/lib/time";
import type { Category } from "@/lib/types";
import {
  deleteInterview,
  moveInterview,
  putInterviewOnAgenda,
  scheduleInterview,
  updateInterview,
} from "@/server/actions/jobs";

const DURATIONS = [30, 45, 60, 90, 120, 180];

const field = "w-full rounded border border-line bg-background px-2 py-1 text-xs outline-none focus:border-accent";

function minutesOf(i: Pick<Interview, "starts_at" | "ends_at">) {
  return Math.round((Date.parse(i.ends_at) - Date.parse(i.starts_at)) / 60_000);
}

function plus(isoStart: string, minutes: number) {
  return new Date(Date.parse(isoStart) + minutes * 60_000).toISOString();
}

/** Next full hour tomorrow at 10:00, Paris time — a sane default to edit from. */
function defaultStart(): string {
  const tomorrow = new Date(Date.now() + 86_400_000);
  return `${toLocalInput(tomorrow.toISOString()).slice(0, 10)}T10:00`;
}

export function ScheduleInterviewForm({
  applicationId,
  categories,
  defaultCategoryId,
  onDone,
}: {
  applicationId: string;
  categories: Category[];
  defaultCategoryId: string | null;
  onDone: () => void;
}) {
  const { pending, error, run, setError } = useAction();
  const [kind, setKind] = useState<InterviewKind>("screening");
  const [start, setStart] = useState(defaultStart);
  const [minutes, setMinutes] = useState(45);
  const [withWhom, setWithWhom] = useState("");
  const [location, setLocation] = useState("");
  const [onAgenda, setOnAgenda] = useState(true);
  const [categoryId, setCategoryId] = useState<string | null>(defaultCategoryId);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const startsAt = fromLocalInput(start);
        if (!startsAt) return setError("Pick a date and a time.");
        if (onAgenda && !categoryId) return setError("Pick the category the interview counts as on the agenda.");
        run(
          () =>
            scheduleInterview({
              applicationId,
              kind,
              startsAt,
              endsAt: plus(startsAt, minutes),
              withWhom: withWhom || null,
              location: location || null,
              categoryId: onAgenda ? categoryId : null,
            }),
          onDone,
        );
      }}
      className="mb-3 grid grid-cols-2 gap-2 rounded border border-line bg-background/50 p-3 text-xs"
    >
      <label className="col-span-2 sm:col-span-1">
        <span className="text-muted">Kind</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as InterviewKind)} className={`mt-0.5 ${field}`}>
          {INTERVIEW_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="col-span-2 sm:col-span-1">
        <span className="text-muted">Duration</span>
        <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={`mt-0.5 ${field}`}>
          {DURATIONS.map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} min` : `${m / 60} h`.replace(".5 h", " h 30")}
            </option>
          ))}
        </select>
      </label>
      <label className="col-span-2">
        <span className="text-muted">When (Paris time)</span>
        <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required className={`mt-0.5 ${field}`} />
      </label>
      <label className="col-span-2 sm:col-span-1">
        <span className="text-muted">With</span>
        <input value={withWhom} onChange={(e) => setWithWhom(e.target.value)} placeholder="Maxime (DS lead)" className={`mt-0.5 ${field}`} />
      </label>
      <label className="col-span-2 sm:col-span-1">
        <span className="text-muted">Where</span>
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Meet link or address" className={`mt-0.5 ${field}`} />
      </label>
      <label className="col-span-2 flex items-center gap-2">
        <input type="checkbox" checked={onAgenda} onChange={(e) => setOnAgenda(e.target.checked)} />
        <span>Put it on the agenda (and Google)</span>
      </label>
      {onAgenda && (
        <div className="col-span-2">
          <span className="text-muted">Counts as</span>
          <div className="mt-0.5">
            <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} placeholder="Interview category…" />
          </div>
        </div>
      )}
      <div className="col-span-2 flex items-center gap-2">
        <button type="submit" disabled={pending} className="rounded bg-accent px-2.5 py-1 font-medium text-white disabled:opacity-50">
          {pending ? "Scheduling…" : "Schedule"}
        </button>
        <button type="button" onClick={onDone} className="text-muted hover:text-foreground">
          Cancel
        </button>
        <ErrorLine error={error} />
      </div>
    </form>
  );
}

export function InterviewCard({
  interview: i,
  past,
  categories,
  defaultCategoryId,
}: {
  interview: Interview;
  past: boolean;
  categories: Category[];
  defaultCategoryId: string | null;
}) {
  const { pending, error, run } = useAction();
  const [editingTime, setEditingTime] = useState(false);
  const [start, setStart] = useState(toLocalInput(i.starts_at));
  const [minutes, setMinutes] = useState(minutesOf(i));
  const [categoryId, setCategoryId] = useState<string | null>(defaultCategoryId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const week = isoWeekStartInTimeZone(new Date(i.starts_at), APP_TIMEZONE);

  const prep = (
    <div>
      <div className="mb-1 text-[11px] font-medium text-muted">Prep</div>
      <NotesEditor
        value={i.prep_notes}
        onSave={(prepNotes) => run(() => updateInterview(i.id, { prepNotes }))}
        placeholder="Ask Claude to prepare this interview: it writes here. Yours to edit too."
        addLabel="Add prep"
        startClosed
      />
    </div>
  );
  const debrief = (
    <div>
      <div className="mb-1 text-[11px] font-medium text-muted">Debrief</div>
      <NotesEditor
        value={i.debrief_notes}
        onSave={(debriefNotes) => run(() => updateInterview(i.id, { debriefNotes }))}
        placeholder={"Questions asked, how it went, next steps…\n## Questions\n- \n## Next"}
        addLabel="Add debrief"
        startClosed
      />
    </div>
  );

  return (
    <article id={`interview-${i.id}`} className={`rounded border border-line p-3 text-xs ${past ? "bg-background/40" : ""} ${pending ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Kind"
          value={i.kind}
          onChange={(e) => run(() => updateInterview(i.id, { kind: e.target.value as InterviewKind }))}
          className="rounded border border-transparent bg-transparent font-medium outline-none hover:border-line"
        >
          {INTERVIEW_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <button onClick={() => setEditingTime((v) => !v)} className="tabular-nums hover:text-accent" title="Change the time">
          {fmtDateTime(i.starts_at)}–{fmtTimeOnly(i.ends_at)}
        </button>
        <span className="ml-auto">
          {i.scheduled_block_id ? (
            <Link href={`/agenda?w=${week}`} className="text-muted hover:text-foreground">
              on the agenda ↗
            </Link>
          ) : (
            <span className="text-amber-600">not on the agenda</span>
          )}
        </span>
      </div>

      {editingTime && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const startsAt = fromLocalInput(start);
            if (!startsAt) return;
            run(() => moveInterview(i.id, startsAt, plus(startsAt, minutes)), () => setEditingTime(false));
          }}
          className="mt-2 flex flex-wrap items-center gap-2"
        >
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="rounded border border-line bg-background px-1 py-0.5" />
          <input
            type="number"
            min={5}
            max={720}
            step={5}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            className="w-16 rounded border border-line bg-background px-1 py-0.5"
          />
          <span className="text-muted">min</span>
          <button type="submit" className="text-accent">
            Move
          </button>
        </form>
      )}

      <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <span className="text-muted">With</span>
        <InlineText value={i.with_whom ?? ""} placeholder="who" onSave={(v) => run(() => updateInterview(i.id, { withWhom: v || null }))} />
        <span className="text-muted">Where</span>
        <span className="min-w-0 truncate">
          {i.location && /^https?:\/\//.test(i.location) && (
            <a href={i.location} target="_blank" rel="noreferrer noopener" className="mr-2 text-accent underline">
              join ↗
            </a>
          )}
          <InlineText value={i.location ?? ""} placeholder="link or address" onSave={(v) => run(() => updateInterview(i.id, { location: v || null }))} />
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-3 border-t border-line pt-2">
        {/* Before: prep first. After: the debrief is what you came to write. */}
        {past ? (
          <>
            {debrief}
            {prep}
          </>
        ) : (
          <>
            {prep}
            {debrief}
          </>
        )}
      </div>

      {!i.scheduled_block_id && !past && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-2">
          <div className="min-w-48 flex-1">
            <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} placeholder="Counts as…" />
          </div>
          <button
            disabled={!categoryId}
            onClick={() => categoryId && run(() => putInterviewOnAgenda(i.id, categoryId))}
            className="text-accent disabled:opacity-50"
          >
            Put on the agenda
          </button>
        </div>
      )}

      <div className="mt-2 flex items-center justify-end gap-2">
        <ErrorLine error={error} />
        {confirmDelete ? (
          <>
            <span className="text-muted">Delete{i.scheduled_block_id ? " (and its agenda block)" : ""}?</span>
            <button onClick={() => setConfirmDelete(false)} className="text-muted">
              Keep
            </button>
            <button onClick={() => run(() => deleteInterview(i.id))} className="text-red-500">
              Delete
            </button>
          </>
        ) : (
          <button onClick={() => setConfirmDelete(true)} className="text-muted hover:text-red-500">
            Delete
          </button>
        )}
      </div>
    </article>
  );
}
