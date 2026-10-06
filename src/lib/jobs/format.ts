/**
 * Date formatting for /jobs. Always in the app's zone, so the server and the
 * browser print the same thing and the page hydrates without a mismatch.
 */

export const APP_TIMEZONE = process.env.NEXT_PUBLIC_APP_TIMEZONE ?? "Europe/Paris";

export function fmtDate(iso: string | null, opts: Intl.DateTimeFormatOptions = {}): string {
  if (!iso) return "";
  // A bare date is a calendar day: read it at noon UTC so no zone moves it.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: APP_TIMEZONE, ...opts });
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: APP_TIMEZONE,
  });
}

export function fmtTimeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: APP_TIMEZONE });
}

/** `yyyy-mm-ddThh:mm` in the app's zone, for a datetime-local input. */
export function toLocalInput(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/**
 * A datetime-local value read in the app's zone, as an ISO instant ("" if it
 * is not one). The input
 * has no zone of its own; the browser's would do on Arthur's laptop but not on
 * a phone abroad, and the agenda is planned in Paris time.
 */
export function fromLocalInput(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return "";
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  // Guess as UTC, then correct by the zone's offset at that instant (twice, for DST edges).
  let t = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const shown = toLocalInput(new Date(t).toISOString());
    const [sy, smo, sd, sh, smi] = shown.split(/[-T:]/).map(Number);
    t += Date.UTC(y, mo - 1, d, h, mi) - Date.UTC(sy, smo - 1, sd, sh, smi);
  }
  return new Date(t).toISOString();
}
