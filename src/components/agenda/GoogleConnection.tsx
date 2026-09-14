"use client";

import { useState, useTransition } from "react";
import type { GoogleAccount, GoogleSyncState } from "@/lib/types";
import {
  disconnectGoogle,
  googleConsentUrl,
  setBusyCalendars,
  syncGoogleNow,
} from "@/server/actions/google";

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
  calendars: GoogleSyncState[];
  notice: { error?: string; connected?: boolean };
};

export function GoogleConnection({ account, calendars, notice }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(notice.error ?? null);
  const [busyIds, setBusyIds] = useState<string[]>(account?.busy_calendar_ids ?? []);

  const connected = Boolean(account && !account.disconnected_at);

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

  function run(fn: () => Promise<{ ok: boolean; error?: string } | void>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result && "ok" in result && !result.ok) setError(result.error ?? "Failed");
    });
  }

  function toggleCalendar(id: string, on: boolean) {
    const next = on ? [...busyIds, id] : busyIds.filter((x) => x !== id);
    setBusyIds(next);
    run(() => setBusyCalendars(next));
  }

  return (
    <section className="rounded-lg border border-line bg-surface p-4 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h2 className="font-medium">Google Calendar</h2>
          <p className="mt-0.5 text-xs text-muted">
            Read-only. Your commitments block time in the planner; nothing is ever
            written back to Google.
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
                if (confirm("Disconnect Google Calendar and delete the mirrored events?")) {
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

      {error && (
        <p className="mt-3 rounded border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-500">
          {error}
        </p>
      )}

      {account?.last_error && !error && (
        <p className="mt-3 rounded border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-500">
          {account.last_error}
        </p>
      )}

      {connected && (
        <>
          <p className="mt-3 text-xs text-muted">
            Connected as {account?.google_email ?? "your Google account"}.
          </p>

          <ul className="mt-3 space-y-1">
            {calendars.map((calendar) => {
              const on = busyIds.includes(calendar.google_calendar_id);
              return (
                <li
                  key={calendar.google_calendar_id}
                  className="flex flex-wrap items-center gap-2 rounded border border-line px-2 py-1.5 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) =>
                      toggleCalendar(calendar.google_calendar_id, e.target.checked)
                    }
                    className="accent-[var(--accent)]"
                  />
                  <span className="flex-1 truncate">
                    {calendar.summary ?? calendar.google_calendar_id}
                  </span>
                  <span
                    className={
                      calendar.last_error ? "text-red-500" : "tabular-nums text-muted"
                    }
                    title={calendar.last_error ?? undefined}
                  >
                    {calendar.last_error
                      ? "sync failing"
                      : `synced ${relativeTime(calendar.last_synced_at)}`}
                  </span>
                </li>
              );
            })}
          </ul>

          <p className="mt-2 text-[11px] text-muted">
            Ticked calendars block time in the week grid. Events you marked as free
            in Google, and invitations you declined, never block.
          </p>
        </>
      )}
    </section>
  );
}
