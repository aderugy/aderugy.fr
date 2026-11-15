"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { fmtDuration } from "@/lib/live/session";
import type { RunningSession } from "@/server/live/data";

/**
 * The running live session, kept fresh. `initial` comes from the layout when
 * it can read the session; `undefined` (a statically rendered page) means
 * "ask /api/now". Either way it is read again whenever the app comes back to
 * the foreground — the installed app is often left open for hours, and the
 * session may have been started or ended from another device or by Claude.
 */
export function useRunningSession(initial?: RunningSession | null): RunningSession | null {
  const [fetched, setFetched] = useState<{ value: RunningSession | null; for: RunningSession | null | undefined } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/now?scope=live", { cache: "no-store" });
        const value = res.status === 200 ? ((await res.json()) as { live: RunningSession | null }).live : null;
        if (alive) setFetched({ value, for: initial });
      } catch {
        // Offline or a deploy in flight: keep what the page was rendered with.
      }
    };
    if (initial === undefined) void load();
    const onShow = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [initial]);

  // A fresh `initial` from the server (a refresh after starting or ending a
  // session) wins over an older fetch.
  if (fetched && fetched.for === initial) return fetched.value;
  return initial ?? null;
}

function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * The header's way back to the table: on every poker page while a session
 * runs, except on the table itself. One tap from a player, a hand, the solver
 * notes or the calculator.
 */
export function RunningSessionLink({ initial }: { initial?: RunningSession | null }) {
  const session = useRunningSession(initial);
  const path = usePathname();
  const now = useMinute();
  if (!session) return null;
  const href = `/poker/live/${session.id}`;
  if (path === href) return null;
  const elapsed = Math.max(0, now - Date.parse(session.started_at));
  return (
    <Link
      href={href}
      title={`Back to the table — ${session.venue}`}
      className="flex h-7 min-w-0 max-w-xs shrink-0 items-center gap-1.5 rounded-full bg-accent pr-2.5 pl-2 text-xs font-medium text-white shadow-sm sm:max-w-xs"
    >
      <LiveDot />
      {/* A phone's header is short of room: "Table" says where it leads. */}
      <span className="sm:hidden">Table</span>
      <span className="hidden truncate sm:inline">{session.venue}</span>
      <span className="shrink-0 tabular-nums opacity-80">{fmtDuration(elapsed)}</span>
    </Link>
  );
}

export function LiveDot({ className = "" }: { className?: string }) {
  return (
    <span className={`relative flex size-2 shrink-0 ${className}`} aria-hidden>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60 motion-reduce:animate-none" />
      <span className="relative inline-flex size-2 rounded-full bg-current" />
    </span>
  );
}
