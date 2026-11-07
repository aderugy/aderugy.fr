"use client";

import { useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { compareSteps } from "@/lib/projects/types";
import type { ProjectState } from "@/server/projects/data";
import { saveItem } from "@/server/actions/projects";
import { OriginBadge, TriageChip, btn, input, useAction } from "./bits";

/**
 * The parking-lot review (R-B step 4b): one item at a time — keep (assign to a
 * step), merge (drop it with a note naming the item it went into), or drop.
 * Works on the list as it was when the review started, so ticking through it
 * does not reshuffle under the thumb.
 */
export function ParkingReview({ state, onClose }: { state: ProjectState; onClose: () => void }) {
  const [queue] = useState(() => state.items.filter((i) => i.kind === "park" && i.status === "open"));
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<"choose" | "assign" | "merge">("choose");
  const [target, setTarget] = useState("");
  const [triage, setTriage] = useState(queue[0]?.triage ?? null);
  const { pending, error, run } = useAction();

  const item = queue[index];
  const steps = [...state.steps].filter((s) => s.status === "todo" || s.status === "open").sort(compareSteps);
  const others = state.items.filter((i) => i.status === "open" && i.id !== item?.id);

  const advance = () => {
    setMode("choose");
    setTarget("");
    setTriage(queue[index + 1]?.triage ?? null);
    setIndex(index + 1);
  };

  if (!item) {
    return (
      <Sheet title="Revue du parking" onClose={onClose}>
        <p className="py-6 text-center text-sm text-muted">Revue terminée — {queue.length} élément{queue.length > 1 ? "s" : ""} passé{queue.length > 1 ? "s" : ""}.</p>
        <button type="button" onClick={onClose} className={`w-full ${btn}`}>
          Fermer
        </button>
      </Sheet>
    );
  }

  const blocks = item.blocks_step_id ? state.steps.find((s) => s.id === item.blocks_step_id) : null;
  return (
    <Sheet title={`Revue du parking · ${index + 1} / ${queue.length}`} onClose={onClose}>
      <div className="rounded border border-line bg-surface p-3">
        <div className="flex items-center gap-2">
          <OriginBadge origin={item.origin} />
          <TriageChip triage={triage} onChange={setTriage} />
          <span className="text-sm font-medium">{item.title}</span>
        </div>
        {blocks && (
          <p className="mt-1 text-xs text-muted">
            bloque {blocks.code} {blocks.title}
          </p>
        )}
      </div>

      {mode === "choose" && (
        <div className="mt-4 grid grid-cols-3 gap-2">
          <button type="button" onClick={() => { setMode("assign"); setTarget(item.blocks_step_id ?? steps[0]?.id ?? ""); }} className={btn}>
            Garder
          </button>
          <button type="button" onClick={() => setMode("merge")} className={btn}>
            Fusionner
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => saveItem(state.project.id, { id: item.id, status: "dropped", triage }), advance)}
            className={btn}
          >
            Abandonner
          </button>
        </div>
      )}

      {mode === "assign" && (
        <form
          className="mt-4 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => saveItem(state.project.id, { id: item.id, step_id: target, triage }), advance);
          }}
        >
          <label className="block text-xs text-muted">
            Dans l&apos;étape
            <select value={target} onChange={(e) => setTarget(e.target.value)} className={`mt-1 ${input}`}>
              {steps.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} {s.title}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={() => setMode("choose")} className={btn}>
              ←
            </button>
            <button disabled={pending || !target} className={`flex-1 ${btn}`}>
              Garder dans cette étape
            </button>
          </div>
        </form>
      )}

      {mode === "merge" && (
        <form
          className="mt-4 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            const into = others.find((o) => o.id === target);
            if (!into) return;
            run(
              () => saveItem(state.project.id, { id: item.id, status: "dropped", close_note: `fusionné dans : ${into.title}`.slice(0, 300) }),
              advance,
            );
          }}
        >
          <label className="block text-xs text-muted">
            Fusionner dans
            <select value={target} onChange={(e) => setTarget(e.target.value)} className={`mt-1 ${input}`}>
              <option value="">—</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.kind === "park" ? "⧗ " : `${state.steps.find((s) => s.id === o.step_id)?.code ?? ""} · `}
                  {o.title}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={() => setMode("choose")} className={btn}>
              ←
            </button>
            <button disabled={pending || !target} className={`flex-1 ${btn}`}>
              Fusionner
            </button>
          </div>
        </form>
      )}

      <button type="button" onClick={advance} className="mt-4 w-full text-center text-xs text-muted underline">
        passer
      </button>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </Sheet>
  );
}
