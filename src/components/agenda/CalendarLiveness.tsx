"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { syncGoogleNow } from "@/server/actions/google";

const STALE_AFTER_MS = 60_000;

/**
 * Two of the four freshness layers, both invisible.
 *
 * - On mount: if the mirror is older than a minute, ask for a sync. Push and
 *   cron usually got there first, so this is normally a no-op — but it is what
 *   guarantees the week you are *looking at* is current.
 * - While open: subscribe to changes on `external_events` so a sync triggered
 *   by a Google push shows up without a reload.
 */
export function CalendarLiveness({
  connected,
  oldestSyncAt,
}: {
  connected: boolean;
  oldestSyncAt: string | null;
}) {
  const router = useRouter();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!connected) return;

    const stale =
      !oldestSyncAt || Date.now() - Date.parse(oldestSyncAt) > STALE_AFTER_MS;
    if (!stale) return;

    let cancelled = false;
    void syncGoogleNow().then(() => {
      if (!cancelled) router.refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [connected, oldestSyncAt, router]);

  useEffect(() => {
    if (!connected) return;

    const supabase = createClient();
    const channel = supabase
      .channel("external-events")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "external_events" },
        () => {
          // A sync writes many rows at once; coalesce the burst into one refresh.
          if (refreshTimer.current) clearTimeout(refreshTimer.current);
          refreshTimer.current = setTimeout(() => router.refresh(), 400);
        },
      )
      .subscribe();

    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      void supabase.removeChannel(channel);
    };
  }, [connected, router]);

  return null;
}
