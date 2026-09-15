"use client";

import { useSyncExternalStore } from "react";

/**
 * Tailwind's breakpoints, mirrored here because the layout has to branch in
 * JavaScript as well as in CSS. The grid cannot be made to show one day at a
 * time with a media query alone: how many columns exist is a render decision,
 * and the pointer maths that places a block reads from the same number.
 *
 * Keep in step with the `md:` / `xl:` prefixes used in the agenda components.
 */
export const MD = "(min-width: 768px)";
export const XL = "(min-width: 1280px)";

const EMPTY = () => () => {};

/**
 * Subscribes to a media query.
 *
 * The server has no viewport, so it answers `false` and the first client paint
 * agrees with it — anything else is a hydration mismatch. Callers therefore get
 * the narrow layout for one frame and the wide one immediately after, which is
 * the right way round: the narrow layout is a subset, so it never flashes
 * content that then has to be taken away.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    typeof window === "undefined"
      ? EMPTY
      : (onChange) => {
          const list = window.matchMedia(query);
          list.addEventListener("change", onChange);
          return () => list.removeEventListener("change", onChange);
        },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * False while rendering on the server and through hydration, true afterwards.
 *
 * For values that depend on the machine the page is running on — "today", above
 * all. The server's clock and time zone are not the reader's, so working out
 * which day to open on during the server render risks disagreeing with the
 * client about it and breaking hydration. Deferring the question by one render
 * costs nothing visible and cannot disagree with anything.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}
