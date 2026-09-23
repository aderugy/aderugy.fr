"use client";

import { ajouterSession, marquerCoursLu, marquerEtat } from "@/server/actions/maths";
import { ETAT } from "@/lib/maths/etat";

const ETATS = ["none", "in-progress", "learned", "mastered"] as const;

const LIBELLE: Record<(typeof ETATS)[number], string> = {
  none: "non commencé",
  "in-progress": ETAT["in-progress"].label,
  learned: ETAT.learned.label,
  mastered: ETAT.mastered.label,
};

export function MarquageEtat({
  nodeId,
  courant,
  courseRead,
}: {
  nodeId: string;
  courant: (typeof ETATS)[number];
  courseRead: boolean;
}) {
  return (
    <div className="chrome flex flex-col gap-2">
      <form action={marquerCoursLu.bind(null, nodeId)}>
        <input type="hidden" name="read" value={courseRead ? "0" : "1"} />
        <button
          type="submit"
          className="w-full rounded border border-line bg-surface px-2 py-1 text-left hover:border-accent"
        >
          {courseRead ? "✓ cours lu" : "marquer le cours comme lu"}
        </button>
      </form>

      <form action={marquerEtat.bind(null, nodeId)} className="flex flex-col gap-1">
        <label className="text-muted" htmlFor="manual">
          marquage manuel
        </label>
        <select
          id="manual"
          name="manual"
          defaultValue={courant}
          className="rounded border border-line bg-surface px-2 py-1 focus:border-accent focus:outline-none"
        >
          {ETATS.map((e) => (
            <option key={e} value={e}>
              {LIBELLE[e]}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded bg-accent px-2 py-1 text-white"
        >
          enregistrer
        </button>
      </form>
    </div>
  );
}

export function JournalSession({ nodeId }: { nodeId: string }) {
  return (
    <form
      action={ajouterSession.bind(null, nodeId)}
      className="chrome flex flex-col gap-1"
    >
      <label className="text-muted" htmlFor="minutes">
        durée (min)
      </label>
      <input
        id="minutes"
        name="minutes"
        type="number"
        min={0}
        max={1440}
        defaultValue={60}
        required
        className="rounded border border-line bg-surface px-2 py-1 focus:border-accent focus:outline-none"
      />
      <label className="text-muted" htmlFor="note">
        ce qui a bloqué
      </label>
      <textarea
        id="note"
        name="note"
        rows={3}
        className="rounded border border-line bg-surface px-2 py-1 focus:border-accent focus:outline-none"
      />
      <button
        type="submit"
        className="rounded bg-accent px-2 py-1 text-white"
      >
        ajouter au journal
      </button>
    </form>
  );
}
