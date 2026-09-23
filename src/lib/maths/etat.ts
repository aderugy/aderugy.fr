import type { ProgressState } from "@/lib/maths/graph/types";

/**
 * La couleur encode l'état de maîtrise, et rien d'autre : une seule teinte,
 * quatre intensités croissantes, tirée de l'accent du site. Rampe et textes
 * sont définis dans src/app/maths/maths.css, en clair comme en sombre.
 */
export const ETAT: Record<
  ProgressState,
  { label: string; fill: string; text: string; border: string }
> = {
  locked: {
    label: "verrouillé",
    fill: "transparent",
    text: "var(--muted)",
    border: "var(--border)",
  },
  available: {
    label: "disponible",
    fill: "var(--maitrise-10)",
    text: "var(--maitrise-texte-10)",
    border: "var(--maitrise-40)",
  },
  "in-progress": {
    label: "en cours",
    fill: "var(--maitrise-40)",
    text: "var(--maitrise-texte-40)",
    border: "var(--maitrise-70)",
  },
  learned: {
    label: "acquis",
    fill: "var(--maitrise-70)",
    text: "var(--maitrise-texte-70)",
    border: "var(--maitrise-70)",
  },
  mastered: {
    label: "maîtrisé",
    fill: "var(--maitrise-100)",
    text: "var(--maitrise-texte-100)",
    border: "var(--maitrise-100)",
  },
};

export const ORDRE: ProgressState[] = [
  "locked",
  "available",
  "in-progress",
  "learned",
  "mastered",
];

/** Marqueur textuel, pour la vue arborescente et les listes. */
export function marqueur(state: ProgressState): string {
  return ["▯", "▨", "▤", "▥", "▮"][ORDRE.indexOf(state)];
}

export function heures(h: number): string {
  return `${h} h`;
}

export function minutes(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, "0")}`;
}

/**
 * Date et heure courtes, en heure de Paris. Supabase renvoie des horodatages
 * ISO complets (`2026-09-23T08:14:03.12+00:00`) là où SQLite rendait
 * `2026-09-23 08:14:03` ; on affiche la même chose qu'avant, à la minute.
 */
export function dateCourte(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
