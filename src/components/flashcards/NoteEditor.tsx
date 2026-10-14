"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import { Rich } from "./Rich";
import { DeckSelect } from "./DeckList";
import { checkDuplicate, saveNote, uploadImage } from "@/server/actions/flashcards";
import { cardOrds, findGaps, sidesOf } from "@/lib/flashcards/notes";
import { KIND_LABELS, NOTE_KINDS, type NoteKind } from "@/lib/flashcards/types";

export type EditableNote = {
  id?: string;
  deck_id: string;
  kind: NoteKind;
  front: string;
  back: string;
  extra: string | null;
  source: string | null;
  tags: string[];
};

const HINTS: Record<NoteKind, { front: string; back: string; backLabel: string; frontLabel: string }> = {
  basic: { frontLabel: "Front", backLabel: "Back", front: "Question. Markdown, $math$, ```code```, pasted images.", back: "Answer" },
  reversed: { frontLabel: "Front", backLabel: "Back", front: "Term — also asked the other way round", back: "Definition" },
  cloze: {
    frontLabel: "Text",
    backLabel: "Back extra (optional)",
    front: "Write the text and hide parts of it: {{c1::answer}} or {{c1::answer::hint}}. One card per number.",
    back: "Shown under the answer",
  },
  type_answer: { frontLabel: "Front", backLabel: "Answer to type", front: "Question", back: "The exact answer, short (a number, a term)" },
};

/** Downscale a pasted image in the browser so it stays under 1 MB. */
async function shrink(file: File): Promise<Blob> {
  if (file.type === "image/gif" && file.size <= 1024 * 1024) return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.85, 0.7, 0.5]) {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", quality));
    // Browsers that cannot encode WebP hand back a PNG, which is fine too.
    if (blob && blob.size <= 1024 * 1024) return blob;
  }
  throw new Error("This image is too large even after shrinking it.");
}

/**
 * Write or edit a note. A new note keeps its deck, kind and tags for the next
 * one ("Add" clears the fields only), so a run of notes is quick to type.
 * Ctrl/⌘+Enter saves; Ctrl/⌘+Shift+C turns the selection into the next cloze
 * gap; pasting an image uploads it and inserts it.
 */
export function NoteEditor({
  decks,
  note,
  defaults,
  cards,
  compact = false,
  onSaved,
}: {
  decks: { id: string; path: string; depth: number }[];
  note?: EditableNote;
  defaults?: { deckId?: string; kind?: NoteKind; tags?: string[] };
  /** The note's cards, to warn before an edit deletes some with history. */
  cards?: { ord: number; reps: number }[];
  compact?: boolean;
  onSaved?: (note: EditableNote & { id: string }) => void;
}) {
  const router = useRouter();
  const editing = Boolean(note?.id);
  const [kind, setKind] = useState<NoteKind>(note?.kind ?? defaults?.kind ?? "basic");
  const [deckId, setDeckId] = useState(note?.deck_id ?? defaults?.deckId ?? decks[0]?.id ?? "");
  const [front, setFront] = useState(note?.front ?? "");
  const [back, setBack] = useState(note?.back ?? "");
  const [extra, setExtra] = useState(note?.extra ?? "");
  const [source, setSource] = useState(note?.source ?? "");
  const [tags, setTags] = useState((note?.tags ?? defaults?.tags ?? []).join(" "));
  const [more, setMore] = useState(Boolean(note?.extra || note?.source));
  const [showPreview, setShowPreview] = useState(false);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();
  const frontRef = useRef<HTMLTextAreaElement>(null);

  const hint = HINTS[kind];
  const draft = { kind, front, back };
  const ords = useMemo(() => cardOrds({ kind, front, back }), [kind, front, back]);

  const insertAt = (el: HTMLTextAreaElement, text: string, set: (v: string) => void) => {
    const { selectionStart: a, selectionEnd: b, value } = el;
    set(value.slice(0, a) + text + value.slice(b));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = a + text.length;
    });
  };

  const onPaste = (set: (v: string) => void) => async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    const el = e.currentTarget;
    setUploading(true);
    setError(null);
    try {
      const blob = await shrink(file);
      const form = new FormData();
      form.append("file", blob, "pasted");
      const r = await uploadImage(form);
      if (!r.ok) throw new Error(r.error);
      insertAt(el, `![](${r.value})`, set);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const wrapGap = () => {
    const el = frontRef.current;
    if (!el) return;
    const n = Math.max(0, ...findGaps(el.value).map((g) => g.n)) + 1;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const inner = value.slice(a, b) || "…";
    const text = `{{c${n}::${inner}}}`;
    setFront(value.slice(0, a) + text + value.slice(b));
    if (kind !== "cloze") setKind("cloze");
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = a + 6 + String(n).length - 1;
      el.selectionEnd = a + text.length - 2;
    });
  };

  const save = () => {
    setError(null);
    setMessage(null);
    if (!deckId) {
      setError("Create a deck first.");
      return;
    }
    if (cards?.length) {
      const lost = cards.filter((c) => c.reps > 0 && !ords.includes(c.ord));
      if (lost.length && !window.confirm(`This edit deletes ${lost.length} card${lost.length > 1 ? "s" : ""} with review history. Continue?`)) return;
    }
    startTransition(async () => {
      const r = await saveNote({
        id: note?.id,
        deckId,
        kind,
        front,
        back,
        extra: extra || null,
        source: source || null,
        tags,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const saved: EditableNote & { id: string } = {
        id: r.value.id,
        deck_id: deckId,
        kind,
        front: front.trim(),
        back: back.trim(),
        extra: extra.trim() || null,
        source: source.trim() || null,
        tags: tags.split(/[\s,]+/).filter(Boolean),
      };
      const dupNote = r.value.duplicateOf ? " (a note with the same front already exists in this deck)" : "";
      if (onSaved) {
        onSaved(saved);
        return;
      }
      if (editing) {
        setMessage(`Saved${dupNote}.`);
        router.refresh();
      } else {
        setFront("");
        setBack("");
        setExtra("");
        setSource("");
        setDuplicate(null);
        setMessage(`Added ${cardOrds(saved).length} card${cardOrds(saved).length > 1 ? "s" : ""}${dupNote}.`);
        requestAnimationFrame(() => frontRef.current?.focus());
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      save();
    } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      wrapGap();
    }
  };

  const field = "mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent";

  if (decks.length === 0) {
    return (
      <p className="text-sm text-muted">
        Create a deck first, on the <Link href="/flashcards" className="text-accent hover:underline">decks page</Link>.
      </p>
    );
  }

  return (
    <div className="space-y-4 text-sm" onKeyDown={onKeyDown}>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Kind of note">
        {NOTE_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => setKind(k)}
            className={`rounded-full border px-3 py-1 text-xs ${kind === k ? "border-accent bg-accent/10 text-foreground" : "border-line text-muted hover:text-foreground"}`}
          >
            {KIND_LABELS[k]}
          </button>
        ))}
      </div>

      <label className="block">
        <span className="text-xs text-muted">Deck</span>
        <DeckSelect decks={decks} value={deckId} onChange={setDeckId} />
      </label>

      <label className="block">
        <span className="flex items-center text-xs text-muted">
          {hint.frontLabel}
          <button type="button" onClick={wrapGap} className="ml-auto rounded border border-line px-1.5 py-0.5 text-[11px] hover:border-accent" title="Ctrl/⌘+Shift+C">
            [ … ] gap
          </button>
        </span>
        <textarea
          ref={frontRef}
          autoFocus={!editing && !compact}
          value={front}
          onChange={(e) => setFront(e.target.value)}
          onPaste={onPaste(setFront)}
          onBlur={() => {
            if (front.trim() && deckId) void checkDuplicate(deckId, front, note?.id).then(setDuplicate);
          }}
          rows={kind === "cloze" ? 5 : 3}
          placeholder={hint.front}
          className={`${field} font-[inherit]`}
        />
        {duplicate && (
          <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">
            A note with this front is already in the deck.{" "}
            <Link href={`/flashcards/notes/${duplicate}`} className="underline" target="_blank">
              Open it
            </Link>
          </span>
        )}
        {kind === "cloze" && front.trim() && ords.length === 0 && (
          <span className="mt-1 block text-xs text-muted">No gap yet: select a word and press “[ … ] gap”.</span>
        )}
      </label>

      <label className="block">
        <span className="text-xs text-muted">{hint.backLabel}</span>
        <textarea
          value={back}
          onChange={(e) => setBack(e.target.value)}
          onPaste={onPaste(setBack)}
          rows={kind === "type_answer" ? 1 : 3}
          placeholder={hint.back}
          className={field}
        />
      </label>

      <label className="block">
        <span className="text-xs text-muted">Tags (space-separated, “::” for levels)</span>
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="poker::mdf maths::lois" className={field} autoCapitalize="off" />
      </label>

      {more ? (
        <>
          <label className="block">
            <span className="text-xs text-muted">Extra (shown under the answer)</span>
            <textarea value={extra} onChange={(e) => setExtra(e.target.value)} onPaste={onPaste(setExtra)} rows={3} className={field} placeholder="Why, context, a link" />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Source</span>
            <input value={source} onChange={(e) => setSource(e.target.value)} className={field} placeholder="https://… or /maths/n/…" />
          </label>
        </>
      ) : (
        <button type="button" onClick={() => setMore(true)} className="text-xs text-muted hover:text-foreground">
          + Extra and source
        </button>
      )}

      <div>
        <button type="button" onClick={() => setShowPreview((v) => !v)} className="text-xs text-muted hover:text-foreground">
          {showPreview ? "Hide preview" : `Preview ${ords.length} card${ords.length === 1 ? "" : "s"}`}
        </button>
        {showPreview && (
          <div className="mt-2 space-y-3">
            {ords.map((o) => {
              const s = sidesOf(draft, o);
              return (
                <div key={o} className="rounded-lg border border-line bg-surface p-3">
                  <p className="mb-2 text-[11px] text-muted uppercase">
                    Card {kind === "cloze" ? `c${o}` : o === 1 ? "2 (reversed)" : "1"}
                  </p>
                  <Rich source={s.question} className="text-sm" />
                  <hr className="my-2 border-line" />
                  <Rich source={s.answer} className="text-sm" />
                  {extra.trim() && <Rich source={extra} className="mt-2 text-xs text-muted" />}
                </div>
              );
            })}
            {ords.length === 0 && <p className="text-xs text-muted">This note makes no card yet.</p>}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        {error && <p className="w-full text-xs text-red-600">{error}</p>}
        {message && <p className="text-xs text-emerald-700 dark:text-emerald-400">{message}</p>}
        {uploading && <p className="text-xs text-muted">Uploading image…</p>}
        <button
          type="button"
          disabled={pending || uploading}
          onClick={save}
          className="ml-auto rounded-md bg-accent px-4 py-2 text-white disabled:opacity-50"
          title="Ctrl/⌘+Enter"
        >
          {editing ? "Save" : "Add"}
        </button>
      </div>
    </div>
  );
}
