"use client";

import { useState, useTransition } from "react";
import { revokeConnectedApp } from "@/server/actions/oauth";
import { relativeTime } from "./GoogleConnection";

export type ConnectedApp = {
  clientId: string;
  name: string;
  grantedAt: string;
};

/**
 * Apps holding an OAuth grant on this account — today, the Claude connector.
 * Revoking ends their sessions and invalidates their refresh tokens; the app
 * has to go through the consent page again to come back.
 */
export function ConnectedApps({
  apps,
  unavailable,
}: {
  apps: ConnectedApp[];
  /** The OAuth server is off or unreachable: say so instead of an empty list. */
  unavailable: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function revoke(app: ConnectedApp) {
    setError(null);
    startTransition(async () => {
      const result = await revokeConnectedApp(app.clientId);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <section className="rounded-lg border border-line bg-surface p-4 text-sm">
      <h2 className="font-medium">Connected apps</h2>
      <p className="mt-0.5 text-xs text-muted">
        Apps you allowed into your backlog, such as Claude. They can read and edit
        tasks and read categories — nothing else.
      </p>

      {error && (
        <p className="mt-3 rounded border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-500">
          {error}
        </p>
      )}

      {unavailable ? (
        <p className="mt-3 text-xs text-muted">{unavailable}</p>
      ) : apps.length === 0 ? (
        <p className="mt-3 rounded border border-line px-2 py-3 text-center text-xs text-muted">
          No app connected.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {apps.map((app) => (
            <li
              key={app.clientId}
              className="flex items-center gap-3 rounded border border-line px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{app.name}</p>
                <p className="text-xs text-muted">
                  Allowed {relativeTime(app.grantedAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => revoke(app)}
                disabled={pending}
                className="rounded border border-line px-2 py-1 text-xs text-red-500 hover:border-red-500 disabled:opacity-50"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
