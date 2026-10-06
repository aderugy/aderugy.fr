"use client";

import { useState } from "react";
import { Markdown } from "@/components/ui/Markdown";
import { NotesEditor } from "@/components/ui/NotesEditor";
import { ErrorLine } from "./bits";
import { Section, useAction } from "./controls";
import { fmtDateTime } from "@/lib/jobs/format";
import type { Application } from "@/lib/jobs/types";
import { refreshOffer, saveOfferText } from "@/server/actions/jobs";

/**
 * The offer as saved. Collapsed by default past a few lines: it is reference
 * material, read once before an interview, not what the page is about.
 */
export function OfferPanel({ app }: { app: Application }) {
  const { pending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [pasting, setPasting] = useState(false);

  const saved = app.offer_md;
  const meta = saved
    ? `${app.offer_source === "pasted" ? "pasted" : "fetched"} ${app.offer_fetched_at ? fmtDateTime(app.offer_fetched_at) : ""}`
    : null;

  return (
    <Section
      title="Offer"
      aside={
        <span className="flex gap-3 text-xs">
          {app.offer_url && (
            <button
              disabled={pending}
              onClick={() => run(() => refreshOffer(app.id))}
              className="text-muted hover:text-foreground disabled:opacity-50"
              title="Fetch the page again and replace the saved copy"
            >
              {pending ? "Fetching…" : saved ? "Refetch" : "Fetch"}
            </button>
          )}
          <button onClick={() => setPasting((v) => !v)} className="text-muted hover:text-foreground">
            {pasting ? "Cancel" : saved ? "Edit text" : "Paste text"}
          </button>
        </span>
      }
    >
      {!pasting && app.offer_fetch_error && (
        <p className="mb-2 text-xs text-amber-600">
          {saved ? "Last fetch failed: " : ""}
          {app.offer_fetch_error}
        </p>
      )}
      <ErrorLine error={error} />

      {pasting ? (
        <NotesEditor
          value={saved}
          onSave={(md) => run(() => saveOfferText(app.id, md), () => setPasting(false))}
          placeholder="Paste the offer here (Markdown or plain text)."
          rows={12}
        />
      ) : saved ? (
        <div>
          <div className={open ? "" : "relative max-h-48 overflow-hidden"}>
            <Markdown source={saved} />
            {!open && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface to-transparent" />
            )}
          </div>
          <div className="mt-2 flex items-center gap-3 text-xs text-muted">
            <button onClick={() => setOpen((v) => !v)} className="hover:text-foreground">
              {open ? "Collapse" : "Read the whole offer"}
            </button>
            <span className="ml-auto">{meta}</span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted">
          No copy saved yet. {app.offer_url ? "Fetch it, or paste the text if the site refuses." : "Add a link, or paste the text."}
        </p>
      )}
    </Section>
  );
}
