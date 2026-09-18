"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createSpot, deleteSpot, updateSpot } from "@/server/actions/solver";
import type { PokerSpot } from "@/lib/solver/types";

export function SpotList({ spots }: { spots: PokerSpot[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  function create(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    startTransition(async () => {
      const result = await createSpot({ name: trimmed });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
      router.push(`/poker/spots/${result.id}`);
    });
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New spot (e.g. BTN vs BB SRP)"
          className="flex-1 rounded border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={pending || !name.trim()}
          className="rounded bg-accent px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          Create
        </button>
      </form>
      {error && <p className="text-sm text-red-500">{error}</p>}

      {spots.length === 0 ? (
        <p className="rounded border border-line bg-surface p-4 text-sm text-muted">
          No spots yet. Create your first one above.
        </p>
      ) : (
        <ul className="space-y-2">
          {spots.map((spot) => (
            <SpotRow key={spot.id} spot={spot} commit={startTransition} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SpotRow({
  spot,
  commit,
}: {
  spot: PokerSpot;
  commit: (fn: () => void) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(spot.name);

  function save() {
    setEditing(false);
    const trimmed = name.trim();
    if (!trimmed || trimmed === spot.name) {
      setName(spot.name);
      return;
    }
    commit(() => void updateSpot({ id: spot.id, name: trimmed }));
  }

  return (
    <li className="flex items-center gap-2 rounded border border-line bg-surface p-3">
      {editing ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setName(spot.name);
              setEditing(false);
            }
          }}
          className="flex-1 rounded border border-line bg-background px-2 py-1 text-sm outline-none focus:border-accent"
        />
      ) : (
        <Link
          href={`/poker/spots/${spot.id}`}
          className="flex-1 truncate text-sm font-medium hover:text-accent"
        >
          {spot.name}
        </Link>
      )}
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded border border-line px-2 py-0.5 text-xs text-muted hover:border-accent"
      >
        Rename
      </button>
      <button
        type="button"
        onClick={() => {
          if (confirm(`Delete the spot "${spot.name}" and everything in it?`)) {
            commit(() => void deleteSpot(spot.id));
          }
        }}
        className="rounded border border-line px-2 py-0.5 text-xs text-muted hover:border-red-500 hover:text-red-500"
      >
        Delete
      </button>
    </li>
  );
}
