import type { Grade } from "@/lib/trainer/types";

/**
 * Grade badge colours. A plain module (not a client component file), so
 * server pages get the object itself, not a client reference.
 */
export const GRADE_STYLES: Record<Grade, string> = {
  correct: "bg-emerald-600 text-white",
  wrong_band: "bg-amber-500 text-white",
  mistake: "bg-orange-600 text-white",
  blunder: "bg-red-600 text-white",
};
