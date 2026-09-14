"use client";

import { useState, useTransition } from "react";
import { PALETTE } from "@/lib/categories";
import type { CalendarSource, Category, GoogleAccount, GoogleSyncState } from "@/lib/types";
import {
  disconnectGoogle,
  googleConsentUrl,
  syncGoogleNow,
  updateCalendarSource,
} from "@/server/actions/google";
import { CategoryPicker } from "./CategoryPicker";

export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

type Props = {
  account: GoogleAccount | null;
  sources: CalendarSource[];
  syncState: GoogleSyncState[];
  categories: Category[];
  notice: { error?: string };
};

export function GoogleConnection({
  account,
  sources,
  syncState,
  categories,
  notice,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(notice.error ?? null);

  const connected = Boolean(account && !account.disconnected_at);
  const syncByCalendar = new Map(syncState.map((s) => [s.google_calendar_id, s]));

  function connect() {
    setError(null);
    startTransition(async () => {
      try {
        window.location.href = await googleConsentUrl(window.location.origin);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not start the Google consent");
      }
    });
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? "Failed");
    });
  }

  return (
    <section className="rounded-lg border border-line bg-surface p-4 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h2 className="font-medium">Calendars</h2>
          <p className="mt-0.5 text-xs text-muted">
            Read-only. Events from an enabled calendar appear in your week, labelled
            with the name you give it here. Nothing is ever written back.
          </p>
        </div>

        {connected ? (
          <div className="flex gap-2">
            <button
              onClick={() => run(syncGoogleNow)}
              disabled={pending}
              className="rounded border border-line px-2 py-1 text-xs hover:border-accent disabled:opacity-50"
            >
              Sync now
            </button>
            <button
              onClick={() => {
                // The archives are called out on purpose: they are the one part
                // of the mirror reconnecting will not rebuild, because the
                // calendar they came from has already forgotten them.
                if (
                  confirm(
                    "Disconnect Google and delete the mirrored events?\n\nThis also removes the archived past events kept after your calendar deleted them. Reconnecting will not bring those back.",
                  )
                ) {
                  run(disconnectGoogle);
                }
              }}
              disabled={pending}
              className="rounded border border-line px-2 py-1 text-xs text-red-500 hover:border-red-500 disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            onClick={connect}
            disabled={pending}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
          >
            Connect Google Calendar
          </button>
        )}
      </div>

      {(error || (account?.last_error && !error)) && (
        <p className="mt-3 rounded border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-500">
          {error ?? account?.last_error}
        </p>
      )}

      {connected && (
        <>
          <p className="mt-3 text-xs text-muted">
            Connected as {account?.google_email ?? "your Google account"}.
          </p>

          <ul className="mt-3 space-y-2">
            {sources.length === 0 && (
              <li className="rounded border border-line px-2 py-3 text-center text-xs text-muted">
                No calendars discovered yet — run a sync.
              </li>
            )}
            {sources.map((source) => (
              <CalendarRow
                key={source.id}
                source={source}
                categories={categories}
                sync={syncByCalendar.get(source.external_id)}
                onChange={run}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function CalendarRow({
  source,
  categories,
  sync,
  onChange,
}: {
  source: CalendarSource;
  categories: Category[];
  sync: GoogleSyncState | undefined;
  onChange: (fn: () => Promise<{ ok: boolean; error?: string }>) => void;
}) {
  const [name, setName] = useState(source.display_name);
  const [open, setOpen] = useState(false);

  const update = (patch: Parameters<typeof updateCalendarSource>[0] extends infer T
    ? Omit<T & object, "id">
    : never) => onChange(() => updateCalendarSource({ id: source.id, ...patch }));

  return (
    <li className="rounded border border-line px-2 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          checked={source.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
          title={
            source.category_id
              ? "Show this calendar in the planner"
              : "Pick a category first"
          }
          className="accent-[var(--accent)]"
        />

        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim() && name !== source.display_name) update({ displayName: name });
            else setName(source.display_name);
          }}
          title="The name shown on your week grid"
          className="w-32 rounded border border-line bg-surface px-2 py-1 font-medium outline-none focus:border-accent"
          style={{ borderLeft: `3px solid ${source.color}` }}
        />

        <ColorSwatches value={source.color} onPick={(color) => update({ color })} />

        <div className="min-w-40 flex-1">
          <CategoryPicker
            categories={categories}
            value={source.category_id}
            onChange={(categoryId) => update({ categoryId })}
            placeholder="Counts as…"
          />
        </div>

        <span
          className={sync?.last_error ? "text-red-500" : "tabular-nums text-muted"}
          title={sync?.last_error ?? undefined}
        >
          {sync?.last_error ? "sync failing" : relativeTime(sync?.last_synced_at ?? null)}
        </span>

        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded border border-line px-1.5 py-0.5 text-muted hover:border-accent"
          title="More"
        >
          ⋯
        </button>
      </div>

      {!source.category_id && (
        <p className="mt-1 pl-6 text-[11px] text-muted">
          Pick a category before enabling — otherwise its hours would show on the grid
          and count toward nothing.
        </p>
      )}

      {open && (
        <div className="mt-2 space-y-1 border-t border-line pt-2 pl-6">
          <Toggle
            label="All-day events"
            checked={source.include_all_day}
            onChange={(v) => update({ includeAllDay: v })}
          />
          <Toggle
            label="Events marked free"
            checked={source.include_free}
            onChange={(v) => update({ includeFree: v })}
          />
          <Toggle
            label="Invitations you declined"
            checked={source.include_declined}
            onChange={(v) => update({ includeDeclined: v })}
          />
          <p className="pt-1 text-[11px] text-muted">
            Google id: <code>{source.external_id}</code>
          </p>
        </div>
      )}
    </li>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[var(--accent)]"
      />
      {label}
    </label>
  );
}

function ColorSwatches({
  value,
  onPick,
}: {
  value: string;
  onPick: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="h-5 w-5 rounded-full border border-line"
        style={{ backgroundColor: value }}
        title="Colour"
      />
      {open && (
        <div className="absolute left-0 top-6 z-20 flex w-40 flex-wrap gap-1 rounded border border-line bg-surface p-2 shadow-lg">
          {PALETTE.map((color) => (
            <button
              key={color}
              onClick={() => {
                onPick(color);
                setOpen(false);
              }}
              className={`h-4 w-4 rounded-full ${value === color ? "ring-2 ring-accent" : ""}`}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
