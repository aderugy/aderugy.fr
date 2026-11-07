/**
 * Dates for /projects, always in the app's zone so the server and the browser
 * print the same thing and the page hydrates without a mismatch.
 */

export const APP_TIMEZONE = process.env.NEXT_PUBLIC_APP_TIMEZONE ?? "Europe/Paris";

/** "sam. 7 nov., 10:59" */
export function fmtWhenFr(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: APP_TIMEZONE,
  });
}

/** "7 nov. 2026" for a bare date. */
export function fmtDayFr(date: string | null): string {
  if (!date) return "";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "Sat 7 Nov 10:59", for the connector. */
export function fmtWhenEn(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: APP_TIMEZONE,
  });
}
