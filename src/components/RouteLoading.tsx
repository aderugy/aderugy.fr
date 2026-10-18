/**
 * The fallback every signed-in section shows while its page renders.
 *
 * Without a `loading.tsx`, a click on a link to a dynamic page changes nothing
 * on screen until the server has finished: the router cannot prefetch any
 * part of a page that reads cookies, so it waits for all of it. With one, the
 * router prefetches this fallback and swaps it in on the click, then streams
 * the page into place. The layout around it (header, nav) stays as it is.
 *
 * Deliberately plain: a few pulsing bars rather than a per-page skeleton, so
 * it never drifts out of step with the pages it stands in for.
 */
export function RouteLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6"
    >
      <span className="sr-only">Loading…</span>
      <div className="animate-pulse space-y-3" aria-hidden>
        <div className="h-5 w-40 rounded bg-line" />
        <div className="h-4 w-full rounded bg-line/70" />
        <div className="h-4 w-5/6 rounded bg-line/70" />
        <div className="h-4 w-2/3 rounded bg-line/70" />
      </div>
    </div>
  );
}
