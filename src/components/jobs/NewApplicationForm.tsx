"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ErrorLine, TagChip } from "./bits";
import { APPLICATION_STATUSES, STATUS_LABELS, type ApplicationStatus, type JobTag } from "@/lib/jobs/types";
import { createApplication, previewOffer } from "@/server/actions/jobs";

/**
 * Start from the link: "Fetch" reads the offer once, fills the role and the
 * company when the page names them, and keeps the text so saving does not
 * fetch it a second time. Without a fetch, saving tries once on its own.
 */
export function NewApplicationForm({
  tags,
  companies,
  onDone,
  defaultCompany = "",
}: {
  tags: JobTag[];
  companies: { id: string; name: string }[];
  onDone?: () => void;
  defaultCompany?: string;
}) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [company, setCompany] = useState(defaultCompany);
  const [role, setRole] = useState("");
  const [status, setStatus] = useState<ApplicationStatus>("to_apply");
  const [deadline, setDeadline] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [offer, setOffer] = useState<{ markdown: string } | null>(null);
  const [offerNote, setOfferNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, startFetch] = useTransition();
  const [saving, startSave] = useTransition();

  const fetchIt = () => {
    if (!url.trim()) return;
    setOfferNote(null);
    startFetch(async () => {
      const r = await previewOffer(url.trim());
      if (!r.ok) {
        setOffer(null);
        setOfferNote(r.error);
        return;
      }
      setOffer({ markdown: r.markdown });
      if (!role.trim() && r.title) setRole(r.title);
      if (!company.trim() && r.company) setCompany(r.company);
      setOfferNote(`Offer captured — ${r.markdown.length.toLocaleString("en")} characters.`);
    });
  };

  const save = () => {
    setError(null);
    startSave(async () => {
      const r = await createApplication({
        company: { name: company },
        roleTitle: role,
        offerUrl: url || null,
        status,
        deadline: deadline || null,
        tagIds,
        offer: offer ? { markdown: offer.markdown, source: "fetched" } : null,
        fetch: !offer && !offerNote,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onDone?.();
      router.push(`/jobs/${r.id}${r.warning ? `?warning=${encodeURIComponent(r.warning)}` : ""}`);
    });
  };

  const input =
    "w-full rounded border border-line bg-background px-2 py-1 text-sm outline-none focus:border-accent";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="grid gap-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2"
    >
      <label className="sm:col-span-2">
        <span className="text-xs text-muted">Link to the offer</span>
        <div className="mt-1 flex gap-2">
          <input
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setOffer(null);
              setOfferNote(null);
            }}
            onBlur={() => {
              if (url.trim() && !offer && !fetching && !role.trim()) fetchIt();
            }}
            placeholder="https://…"
            className={input}
          />
          <button
            type="button"
            onClick={fetchIt}
            disabled={!url.trim() || fetching}
            className="shrink-0 rounded border border-line px-3 text-sm text-muted hover:text-foreground disabled:opacity-50"
          >
            {fetching ? "Fetching…" : "Fetch"}
          </button>
        </div>
        {offerNote && <p className={`mt-1 text-xs ${offer ? "text-emerald-600" : "text-amber-600"}`}>{offerNote}</p>}
      </label>

      <label>
        <span className="text-xs text-muted">Company</span>
        <input
          list="jobs-companies"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          required
          className={`mt-1 ${input}`}
        />
        <datalist id="jobs-companies">
          {companies.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>
      </label>

      <label>
        <span className="text-xs text-muted">Role</span>
        <input value={role} onChange={(e) => setRole(e.target.value)} required className={`mt-1 ${input}`} />
      </label>

      <label>
        <span className="text-xs text-muted">Status</span>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as ApplicationStatus)}
          className={`mt-1 ${input}`}
        >
          {APPLICATION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span className="text-xs text-muted">Apply before</span>
        <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} className={`mt-1 ${input}`} />
      </label>

      <div className="sm:col-span-2">
        <span className="text-xs text-muted">Type of job</span>
        <div className="mt-1 flex flex-wrap gap-1">
          {tags.length === 0 && (
            <span className="text-xs text-muted">
              No tags yet — create them in{" "}
              <Link href="/jobs/tags" className="underline">
                Tags
              </Link>
              .
            </span>
          )}
          {tags.map((t) => (
            <TagChip
              key={t.id}
              tag={t}
              active={tagIds.includes(t.id)}
              onClick={() =>
                setTagIds((prev) => (prev.includes(t.id) ? prev.filter((x) => x !== t.id) : [...prev, t.id]))
              }
            />
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 sm:col-span-2">
        <button
          type="submit"
          disabled={saving || fetching}
          className="rounded bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save application"}
        </button>
        <ErrorLine error={error} />
      </div>
    </form>
  );
}
