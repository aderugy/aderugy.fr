"use client";

import { useState } from "react";
import { useAction } from "@/components/jobs/controls";
import { renameTag, saveSettings } from "@/server/actions/flashcards";
import type { Settings } from "@/lib/flashcards/types";

const parseSteps = (s: string) =>
  s
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);

/** Scheduling settings, tag renaming and merging, exports. */
export function SettingsForm({ settings, tags }: { settings: Settings; tags: { tag: string; notes: number }[] }) {
  const [s, setS] = useState(settings);
  const [learning, setLearning] = useState(settings.learningSteps.join(" "));
  const [relearning, setRelearning] = useState(settings.relearningSteps.join(" "));
  const [saved, setSaved] = useState(false);
  const { pending, error, run } = useAction();

  const field = "mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent";
  const num = (key: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setS({ ...s, [key]: Number(e.target.value) });
  };

  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 px-4 py-6 text-sm sm:px-6 sm:py-10">
      <section>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <form
          className="mt-4 grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => saveSettings({ ...s, learningSteps: parseSteps(learning), relearningSteps: parseSteps(relearning) }),
              () => setSaved(true),
            );
          }}
        >
          <label className="block sm:col-span-2">
            <span className="text-xs text-muted">
              Target retention: <span className="text-foreground">{Math.round(s.retention * 100)} %</span>. Higher means
              cards come back sooner and more reviews a day; FSRS&apos;s default is 90 %.
            </span>
            <input
              type="range"
              min={0.7}
              max={0.97}
              step={0.01}
              value={s.retention}
              onChange={(e) => {
                setSaved(false);
                setS({ ...s, retention: Number(e.target.value) });
              }}
              className="mt-2 w-full accent-[var(--accent)]"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted">New cards per day</span>
            <input type="number" min={0} max={9999} value={s.newPerDay} onChange={num("newPerDay")} className={field} />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Maximum reviews per day</span>
            <input type="number" min={0} max={99999} value={s.reviewsPerDay} onChange={num("reviewsPerDay")} className={field} />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Learning steps (minutes)</span>
            <input value={learning} onChange={(e) => { setSaved(false); setLearning(e.target.value); }} className={field} placeholder="1 10" />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Relearning steps (minutes, may be empty)</span>
            <input value={relearning} onChange={(e) => { setSaved(false); setRelearning(e.target.value); }} className={field} placeholder="10" />
          </label>
          <label className="block">
            <span className="text-xs text-muted">A review day starts at (hour)</span>
            <input type="number" min={0} max={23} value={s.dayStartsHour} onChange={num("dayStartsHour")} className={field} />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Time zone (change it when travelling)</span>
            <input value={s.timeZone} onChange={(e) => { setSaved(false); setS({ ...s, timeZone: e.target.value.trim() }); }} className={field} placeholder="Europe/Paris" />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Leech after this many lapses</span>
            <input type="number" min={2} max={99} value={s.leechThreshold} onChange={num("leechThreshold")} className={field} />
          </label>
          <label className="flex items-center gap-2 self-end pb-2">
            <input type="checkbox" checked={s.swipeGestures} onChange={(e) => { setSaved(false); setS({ ...s, swipeGestures: e.target.checked }); }} />
            <span>Swipe to rate on a phone (left Again, right Good)</span>
          </label>
          <div className="flex items-center gap-3 sm:col-span-2">
            {error && <p className="text-xs text-red-600">{error}</p>}
            {saved && <p className="text-xs text-emerald-700 dark:text-emerald-400">Saved.</p>}
            <button type="submit" disabled={pending} className="ml-auto rounded-md bg-accent px-4 py-2 text-white disabled:opacity-50">
              Save
            </button>
          </div>
        </form>
      </section>

      <TagManager tags={tags} />

      <section>
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Export</h2>
        <p className="mt-2 text-muted">Everything, every deck. Single decks export from their menu on the decks page.</p>
        <div className="mt-3 flex gap-3">
          <a href="/flashcards/export?format=csv" className="rounded-md border border-line px-3 py-2 hover:border-accent">
            Notes as CSV
          </a>
          <a href="/flashcards/export?format=json" className="rounded-md border border-line px-3 py-2 hover:border-accent">
            Full backup (JSON, with history)
          </a>
        </div>
      </section>
    </main>
  );
}

function TagManager({ tags }: { tags: { tag: string; notes: number }[] }) {
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const { pending, error, run } = useAction();
  return (
    <section>
      <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Tags</h2>
      <p className="mt-2 text-muted">Renaming a tag renames its children too (poker → cash turns poker::mdf into cash::mdf). Renaming onto an existing tag merges them.</p>
      {tags.length === 0 ? (
        <p className="mt-3 text-muted">No tag yet.</p>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-2">
          {tags.map((t) => (
            <li key={t.tag}>
              <button
                type="button"
                onClick={() => {
                  setFrom(t.tag);
                  setTo(t.tag);
                  setMessage(null);
                }}
                className={`rounded-full border px-2.5 py-1 text-xs ${from === t.tag ? "border-accent" : "border-line hover:border-accent"}`}
              >
                #{t.tag} <span className="text-muted">{t.notes}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {from && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              async () => {
                const r = await renameTag(from, to);
                if (r.ok) setMessage(`Renamed on ${r.value} note${r.value === 1 ? "" : "s"}.`);
                return r;
              },
              () => setFrom(null),
            );
          }}
        >
          <span className="text-muted">#{from} →</span>
          <input autoFocus value={to} onChange={(e) => setTo(e.target.value)} className="rounded-md border border-line bg-surface px-2 py-1.5 outline-none focus:border-accent" />
          <button type="submit" disabled={pending || !to.trim() || to.trim() === from} className="rounded-md bg-accent px-3 py-1.5 text-white disabled:opacity-50">
            Rename
          </button>
          <button type="button" onClick={() => setFrom(null)} className="text-xs text-muted">
            Cancel
          </button>
        </form>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      {message && <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">{message}</p>}
    </section>
  );
}
