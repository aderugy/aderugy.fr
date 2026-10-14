"use client";

import { useState, useTransition } from "react";
import { unhideExternalEvent } from "@/server/actions/google";
import type { CalendarSource, HiddenEventRule } from "@/lib/types";

/**
 * Events hidden from the mirrored calendars, per calendar, each with a way
 * back. A title rule hides every event of that title in its calendar; an
 * event rule, one occurrence.
 */
export function HiddenEvents({ rules, sources }: { rules: HiddenEventRule[]; sources: CalendarSource[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const bySource = new Map<string, HiddenEventRule[]>();
  for (const r of rules) bySource.set(r.calendar_source_id, [...(bySource.get(r.calendar_source_id) ?? []), r]);
  const groups = sources.filter((s) => bySource.has(s.id));

  function unhide(id: string) {
    setError(null);
    setBusy(id);
    startTransition(async () => {
      const result = await unhideExternalEvent(id);
      if (!result.ok) setError(result.error);
      setBusy(null);
    });
  }

  return (
    <section id="hidden-events" className="scroll-mt-4 rounded-lg border border-line bg-surface p-4 text-sm">
      <h2 className="font-medium">Hidden events</h2>
      <p className="mt-0.5 text-xs text-muted">
        Events you hid from your calendars: off the grid and out of the totals. Your calendars still have them. Hide one from its
        detail on the week.
      </p>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      {groups.length === 0 ? (
        <p className="mt-3 text-xs text-muted">Nothing hidden.</p>
      ) : (
        <div className="mt-3 space-y-3">
          {groups.map((source) => (
            <div key={source.id}>
              <p className="flex items-center gap-1.5 text-xs font-medium">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: source.color }} />
                {source.display_name}
              </p>
              <ul className="mt-1 divide-y divide-line rounded border border-line">
                {[...(bySource.get(source.id) ?? [])]
                  // Recurring titles first, then single events by date.
                  .sort(
                    (a, b) =>
                      Number(b.title !== null) - Number(a.title !== null) ||
                      (a.starts_at ?? "").localeCompare(b.starts_at ?? "") ||
                      (a.label ?? "").localeCompare(b.label ?? ""),
                  )
                  .map((r) => (
                    <li key={r.id} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                      <span className="min-w-0 flex-1 truncate">
                        {r.title !== null ? (
                          <>Every “{r.title}”</>
                        ) : (
                          <>
                            {r.label ?? "Untitled event"}
                            {r.starts_at && (
                              <span className="text-muted">
                                {" · "}
                                {new Date(r.starts_at).toLocaleDateString(undefined, {
                                  weekday: "short",
                                  day: "numeric",
                                  month: "short",
                                })}
                              </span>
                            )}
                          </>
                        )}
                      </span>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => unhide(r.id)}
                        className="shrink-0 rounded border border-line px-2 py-0.5 hover:border-foreground disabled:opacity-50"
                      >
                        {busy === r.id ? "…" : "Show again"}
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
