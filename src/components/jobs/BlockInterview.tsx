"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Markdown } from "@/components/ui/Markdown";
import { NotesEditor } from "@/components/ui/NotesEditor";
import { KIND_LABELS, type InterviewOnBlock } from "@/lib/jobs/types";
import { updateInterview } from "@/server/actions/jobs";

/**
 * The interview behind a block, in the week view's block panel: what it is,
 * the prep to reread, and the debrief to write right after — without leaving
 * the agenda.
 */
export function BlockInterview({ interview: i }: { interview: InterviewOnBlock }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className={`rounded border border-amber-500/40 bg-amber-500/5 p-2 ${pending ? "opacity-60" : ""}`}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">
            {KIND_LABELS[i.kind]} · {i.company}
          </span>
          <span className="block truncate text-[10px] text-muted">{i.role_title}</span>
        </span>
        <Link href={`/jobs/${i.application_id}#interview-${i.id}`} className="shrink-0 text-accent hover:underline">
          Open ↗
        </Link>
      </div>

      {i.prep_notes && (
        <details className="mt-2 border-t border-line pt-1">
          <summary className="cursor-pointer text-[10px] text-muted hover:text-foreground">Prep</summary>
          <Markdown source={i.prep_notes} className="mt-1 text-xs" />
        </details>
      )}

      <div className="mt-2 border-t border-line pt-1">
        <div className="mb-1 text-[10px] text-muted">Debrief</div>
        <NotesEditor
          value={i.debrief_notes}
          onSave={(debriefNotes) =>
            startTransition(async () => {
              setError(null);
              const r = await updateInterview(i.id, { debriefNotes });
              if (!r.ok) setError(r.error);
            })
          }
          placeholder={"How it went, questions asked, next steps…"}
          addLabel="Write the debrief"
          startClosed
          rows={5}
        />
        {error && <p className="mt-1 text-red-500">{error}</p>}
      </div>
    </div>
  );
}
