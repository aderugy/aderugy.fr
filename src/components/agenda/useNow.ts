"use client";

import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;

/**
 * The clock is an external store, so it is subscribed to rather than polled
 * into state. Ticks are lined up with the minute boundary: a plain interval
 * started on mount would drift the caret up to a minute behind the clock it
 * mirrors.
 */
function subscribeToMinute(onTick: () => void) {
  let interval: ReturnType<typeof setInterval> | undefined;
  const timeout = setTimeout(
    () => {
      onTick();
      interval = setInterval(onTick, MINUTE_MS);
    },
    MINUTE_MS - (Date.now() % MINUTE_MS),
  );

  return () => {
    clearTimeout(timeout);
    if (interval) clearInterval(interval);
  };
}

/** Minute resolution, so the snapshot only changes when the caret would move. */
const minuteNow = () => Math.floor(Date.now() / MINUTE_MS);

/** The server has no "now" worth rendering, and hydration must not disagree. */
const noServerNow = () => null;

/** The current minute, or `null` until the client has taken over. */
export function useNow(): Date | null {
  const minute = useSyncExternalStore<number | null>(
    subscribeToMinute,
    minuteNow,
    noServerNow,
  );
  return minute === null ? null : new Date(minute * MINUTE_MS);
}
