"use client";

import { useState, useTransition } from "react";
import { PALETTE } from "@/lib/categories";
import type {
  CalendarSource,
  Category,
  GoogleAccount,
  GoogleSyncState,
  PushStatus,
} from "@/lib/types";
import {
  disableGooglePush,
  disconnectGoogle,
  enableGooglePush,
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
  pushStatus: PushStatus | null;
  notice: { error?: string };
};

const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

export function GoogleConnection({
  account,
  sources,
  syncState,
  categories,
  pushStatus,
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
        <div className="flex-1 max-sm:basis-full">
          <h2 className="font-medium">Calendars</h2>
          <p className="mt-0.5 text-xs text-muted">
            Events from an enabled calendar appear in your week, labelled with the
            name you give it here. Your calendars are only ever read.
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

          <PushSection
            account={account!}
            status={pushStatus}
            pending={pending}
            onRun={run}
            onReconnect={connect}
          />
        </>
      )}
    </section>
  );
}

/**
 * Pushing blocks out to Google.
 *
 * Kept visibly separate from the calendars above: those are read, this one is
 * written, and it is the only calendar the app can write to at all.
 */
function PushSection({
  account,
  status,
  pending,
  onRun,
  onReconnect,
}: {
  account: GoogleAccount;
  status: PushStatus | null;
  pending: boolean;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string }>) => void;
  onReconnect: () => void;
}) {
  const granted = (account.scopes ?? []).includes(WRITE_SCOPE);
  const enabled = Boolean(account.push_enabled);

  const waiting = status?.pending ?? 0;
  const failing = status?.failed ?? 0;

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 max-sm:basis-full">
          <h3 className="font-medium">Push blocks to Google</h3>
          <p className="mt-0.5 text-xs text-muted">
            Every block you plan appears in an <strong>Agenda</strong> calendar the app
            creates in your Google account — on your phone, and to anyone you share it
            with. One-way: edit blocks here; changes made in Google are overwritten.
          </p>
        </div>

        {!granted ? (
          <button
            onClick={onReconnect}
            disabled={pending}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
            title="Google has to grant access to the calendar the app will create"
          >
            Allow in Google
          </button>
        ) : enabled ? (
          <button
            onClick={() => {
              if (
                confirm(
                  "Stop pushing blocks?\n\nThe Agenda calendar is deleted from Google. Your blocks here are untouched.",
                )
              ) {
                onRun(disableGooglePush);
              }
            }}
            disabled={pending}
            className="rounded border border-line px-2 py-1 text-xs text-red-500 hover:border-red-500 disabled:opacity-50"
          >
            Stop pushing
          </button>
        ) : (
          <button
            onClick={() => onRun(enableGooglePush)}
            disabled={pending}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
          >
            Start pushing
          </button>
        )}
      </div>

      {!granted && (
        <p className="mt-2 text-[11px] text-muted">
          Your current connection is read-only. Google will ask once more, for access
          limited to calendars this app creates — it still cannot change any of yours.
        </p>
      )}

      {enabled && (
        <p className="mt-2 text-xs">
          {account.push_error ? (
            <span className="text-red-500">{account.push_error}</span>
          ) : failing > 0 ? (
            <span className="text-red-500" title={status?.last_block_error ?? undefined}>
              {failing} block{failing === 1 ? "" : "s"} could not be pushed
              {status?.last_block_error ? ` — ${status.last_block_error}` : ""}
            </span>
          ) : waiting > 0 ? (
            <span className="text-muted">
              {waiting} block{waiting === 1 ? "" : "s"} on the way…
            </span>
          ) : (
            <span className="text-muted">
              Up to date · last push {relativeTime(account.last_pushed_at ?? null)}
            </span>
          )}
        </p>
      )}
    </div>
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
          className="w-32 rounded border border-line bg-surface px-2 py-1 font-medium outline-none focus:border-accent max-sm:w-full max-sm:min-w-0 max-sm:flex-1 max-sm:basis-full"
          style={{ borderLeft: `3px solid ${source.color}` }}
        />

        <ColorSwatches value={source.color} onPick={(color) => update({ color })} />

        <div className="min-w-40 flex-1 max-sm:min-w-0 max-sm:basis-full">
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
