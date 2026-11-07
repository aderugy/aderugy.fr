import type { ClockState } from "@/lib/projects/clock";

/** Colours of the clock: neutral within budget, amber in drift, red in closing mode. */
export function stateTone(state: ClockState): { bar: string; text: string; label: string } {
  switch (state) {
    case "closing":
      return { bar: "bg-red-500", text: "text-red-600 dark:text-red-400", label: "mode clôture" };
    case "drift":
      return { bar: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", label: "dérive" };
    case "over":
      return { bar: "bg-amber-300 dark:bg-amber-600/70", text: "text-foreground", label: "au-delà du budget" };
    default:
      return { bar: "bg-accent", text: "text-foreground", label: "dans le budget" };
  }
}
