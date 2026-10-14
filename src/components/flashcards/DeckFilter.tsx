"use client";

import { useRouter } from "next/navigation";
import { DeckSelect } from "./DeckList";

/** A deck picker that narrows the page it sits on (`?deck=`). */
export function DeckFilter({ decks, value, path }: { decks: { id: string; path: string; depth: number }[]; value: string | null; path: string }) {
  const router = useRouter();
  return (
    <DeckSelect
      decks={decks}
      value={value ?? ""}
      onChange={(id) => router.push(id ? `${path}?deck=${id}` : path)}
      allowNone="All decks"
      className="!mt-0 !w-auto max-w-[16rem] !py-1.5 text-sm"
    />
  );
}
