"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { LiveDot } from "@/components/poker/RunningSessionLink";
import { APP_TIMEZONE } from "@/lib/jobs/format";
import { fmtDuration } from "@/lib/live/session";
import type { NowSummary } from "@/server/now";

/**
 * The top of the home page once signed in: the live session to get back to,
 * then what the day holds. The page itself is static (it is also the public
 * landing page), so this is read from /api/now in the browser — and kept in
 * localStorage so a returning visit draws it at once, before the fetch lands,
 * instead of pushing the tools down under a thumb about to tap them.
 */

const CACHE_KEY = "home-now:v1";
const TZ = APP_TIMEZONE;

function readCache(): NowSummary | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as NowSummary) : null;
  } catch {
    return null;
  }
}

function writeCache(v: NowSummary | null) {
  try {
    if (v) localStorage.setItem(CACHE_KEY, JSON.stringify(v));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    // Private mode or storage full: the panel just loads a beat later next time.
  }
}

function useNowSummary(): { now: NowSummary | null; at: number } {
  const [state, setState] = useState<{ now: NowSummary | null; at: number }>({ now: null, at: 0 });

  useEffect(() => {
    let alive = true;
    const cached = readCache();
    // localStorage only exists in the browser, so the cached view can only arrive after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (cached) setState({ now: cached, at: Date.now() });
    const load = async () => {
      try {
        const res = await fetch("/api/now", { cache: "no-store" });
        const value = res.status === 200 ? ((await res.json()) as NowSummary) : null;
        writeCache(value);
        if (alive) setState({ now: value, at: Date.now() });
      } catch {
        // Offline: keep the cached view.
      }
    };
    void load();
    const onShow = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onShow);
    const tick = setInterval(() => alive && setState((s) => ({ ...s, at: Date.now() })), 30_000);
    return () => {
      alive = false;
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, []);

  return state;
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });

const dayAndClock = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const day = d.toLocaleDateString("en-CA", { timeZone: TZ });
  const label =
    day === today ? "Today" : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
  return `${label}, ${clock(iso)}`;
};

export function TodayHeading() {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    const d = new Date();
    const hour = Number(d.toLocaleTimeString("en-GB", { hour: "2-digit", hour12: false, timeZone: TZ }));
    const part = hour < 5 ? "Late night" : hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the date is the browser's, not the build's
    setLabel(`${part} · ${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: TZ })}`);
  }, []);
  return <p className="h-5 text-sm text-muted">{label}</p>;
}

export function NowPanel() {
  const { now, at } = useNowSummary();
  if (!now) return null;
  const { live, block, blocksLeft, cardsDue, interview } = now;

  const tiles: ReactNode[] = [];
  tiles.push(
    <Tile key="agenda" href="/agenda" label="Agenda">
      {block ? (
        <>
          <span className="flex items-center gap-1.5">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: block.color }} />
            <span className="truncate font-medium text-foreground">{block.label}</span>
          </span>
          <span className="tabular-nums">
            {block.current ? `Now · until ${clock(block.ends_at)}` : `Next · ${clock(block.starts_at)}–${clock(block.ends_at)}`}
            {blocksLeft > 1 && ` · ${blocksLeft - 1} more`}
          </span>
        </>
      ) : (
        <span>Nothing left planned today</span>
      )}
    </Tile>,
  );
  if (cardsDue !== null) {
    tiles.push(
      <Tile key="cards" href={cardsDue > 0 ? "/flashcards/review" : "/flashcards"} label="Flashcards">
        {cardsDue > 0 ? (
          <>
            <span className="font-medium text-foreground tabular-nums">
              {cardsDue} card{cardsDue === 1 ? "" : "s"} due
            </span>
            <span>Study now →</span>
          </>
        ) : (
          <span>All caught up today</span>
        )}
      </Tile>,
    );
  }
  if (interview) {
    tiles.push(
      <Tile key="interview" href="/jobs" label="Next interview">
        <span className="truncate font-medium text-foreground">{interview.company}</span>
        <span className="tabular-nums">
          {dayAndClock(interview.starts_at)} · {interview.kind}
        </span>
      </Tile>,
    );
  }

  return (
    <section className="mt-8 space-y-3" aria-label="Right now">
      {live && (
        <Link
          href={`/poker/live/${live.id}`}
          className="flex items-center gap-4 rounded-2xl bg-accent p-4 text-white shadow-sm transition-transform active:scale-[0.99]"
        >
          <div className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-[11px] font-semibold tracking-wide uppercase opacity-90">
              <LiveDot /> Live session · since {clock(live.started_at)}
            </span>
            <span className="mt-1 block truncate text-lg font-semibold">{live.venue}</span>
            <span className="block text-sm tabular-nums opacity-80">{fmtDuration(Math.max(0, at - Date.parse(live.started_at)))} at the table</span>
          </div>
          <span className="shrink-0 rounded-full bg-white/15 px-3 py-2 text-sm font-semibold">Table →</span>
        </Link>
      )}
      {/* Phone: the agenda across, the others two by two. From sm: one row. */}
      <div className={`grid grid-cols-2 gap-3 ${tiles.length === 3 ? "sm:grid-cols-3" : tiles.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-1"}`}>
        {tiles.map((t, i) => (
          <div key={i} className={`flex min-w-0 ${i === 0 || (i === tiles.length - 1 && tiles.length % 2 === 0) ? "col-span-2 sm:col-span-1" : ""}`}>
            {t}
          </div>
        ))}
      </div>
    </section>
  );
}

function Tile({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="flex w-full min-w-0 flex-col gap-0.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-xs text-muted transition-colors hover:border-accent"
    >
      <span className="text-[10px] font-semibold tracking-wide uppercase">{label}</span>
      {children}
    </Link>
  );
}
