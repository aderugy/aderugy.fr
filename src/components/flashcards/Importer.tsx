"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { importNotes } from "@/server/actions/flashcards";
import { parseCsv } from "@/lib/flashcards/text";
import { KIND_LABELS, NOTE_KINDS, isNoteKind, type NoteKind } from "@/lib/flashcards/types";
import type { ImportReport, ImportRow } from "@/server/flashcards/data";
import { DeckSelect } from "./DeckList";

const FIELDS = [
  ["ignore", "Ignore"],
  ["front", "Front"],
  ["back", "Back"],
  ["extra", "Extra"],
  ["tags", "Tags"],
  ["deck", "Deck path"],
  ["kind", "Kind"],
  ["source", "Source"],
] as const;
type Field = (typeof FIELDS)[number][0];

const BATCH = 100;

/** Guess a column's field from its header (the export's own headers map back exactly). */
function guess(header: string, i: number): Field {
  const h = header.trim().toLowerCase();
  const known: Record<string, Field> = {
    front: "front", question: "front", recto: "front", back: "back", answer: "back", verso: "back",
    extra: "extra", notes: "extra", tags: "tags", tag: "tags", deck: "deck", kind: "kind", type: "kind", source: "source",
  };
  return known[h] ?? (i === 0 ? "front" : i === 1 ? "back" : "ignore");
}

/**
 * CSV or TSV in, notes out: paste or pick a file, map the columns, choose the
 * deck and what to do with duplicates, check the preview, import. Rows go up
 * in batches so a large file neither times out nor loses everything on one
 * bad row.
 */
export function Importer({ decks }: { decks: { id: string; path: string; depth: number }[] }) {
  const [text, setText] = useState("");
  const [header, setHeader] = useState(true);
  const [mapping, setMapping] = useState<Field[] | null>(null);
  const [deckId, setDeckId] = useState(decks[0]?.id ?? "");
  const [kind, setKind] = useState<NoteKind>("basic");
  const [duplicates, setDuplicates] = useState<"skip" | "update" | "create">("skip");
  const [tags, setTags] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const rows = useMemo(() => (text.trim() ? parseCsv(text) : []), [text]);
  const width = Math.max(0, ...rows.map((r) => r.length));
  const body = header ? rows.slice(1) : rows;
  const cols: Field[] = mapping && mapping.length === width ? mapping : Array.from({ length: width }, (_, i) => guess(header ? (rows[0]?.[i] ?? "") : "", i));

  const toRows = (): ImportRow[] =>
    body.map((r) => {
      const out: ImportRow = { front: "", back: "" };
      cols.forEach((f, i) => {
        const v = r[i]?.trim() ?? "";
        if (f === "ignore" || !v) return;
        if (f === "kind") {
          if (isNoteKind(v)) out.kind = v;
        } else out[f] = v;
      });
      return out;
    });

  const run = () =>
    start(async () => {
      setError(null);
      setReport(null);
      const all = toRows();
      const total: ImportReport = { created: 0, updated: 0, skipped: 0, errors: [] };
      for (let i = 0; i < all.length; i += BATCH) {
        setProgress(`Importing ${Math.min(i + BATCH, all.length)} / ${all.length}…`);
        const r = await importNotes(all.slice(i, i + BATCH), { deckId, kind, duplicates, tags });
        if (!r.ok) {
          setError(r.error);
          break;
        }
        total.created += r.value.created;
        total.updated += r.value.updated;
        total.skipped += r.value.skipped;
        total.errors.push(...r.value.errors.map((e) => ({ row: e.row + i + (header ? 1 : 0), error: e.error })));
      }
      setProgress(null);
      setReport(total);
    });

  const control = "rounded-md border border-line bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent";

  if (decks.length === 0) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm">
        Create a deck first, on the <Link href="/flashcards" className="text-accent hover:underline">decks page</Link>.
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-5 px-4 py-6 text-sm sm:px-6 sm:py-8">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Import</h1>
        <p className="mt-1 text-muted">
          CSV or TSV, one note per line. A file exported from here (Deck → Export CSV) imports back as it was.
        </p>
      </div>

      <div className="space-y-2">
        <input
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) {
              setMapping(null);
              setReport(null);
              setText(await f.text());
            }
          }}
          className="block text-xs"
        />
        <textarea
          value={text}
          onChange={(e) => {
            setMapping(null);
            setReport(null);
            setText(e.target.value);
          }}
          rows={6}
          placeholder={"front,back,tags\nMDF face à un pot-size bet,50 %,poker::mdf"}
          className={`${control} w-full font-mono text-xs`}
        />
      </div>

      {rows.length > 0 && (
        <>
          <label className="flex items-center gap-2 text-muted">
            <input type="checkbox" checked={header} onChange={(e) => { setHeader(e.target.checked); setMapping(null); }} />
            The first line is a header
          </label>

          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  {cols.map((f, i) => (
                    <th key={i} className="border-b border-line p-2 text-left font-normal">
                      <select
                        value={f}
                        onChange={(e) => setMapping(cols.map((c, j) => (j === i ? (e.target.value as Field) : c)))}
                        className={`${control} w-full text-xs`}
                      >
                        {FIELDS.map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                      {header && <span className="mt-1 block truncate text-muted">{rows[0][i]}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.slice(0, 5).map((r, ri) => (
                  <tr key={ri} className="border-b border-line last:border-b-0">
                    {cols.map((f, i) => (
                      <td key={i} className={`max-w-[16rem] truncate p-2 align-top ${f === "ignore" ? "text-muted/50" : ""}`}>
                        {r[i]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {body.length > 5 && <p className="border-t border-line px-2 py-1.5 text-xs text-muted">… and {body.length - 5} more rows</p>}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs text-muted">Deck (rows with a deck path go to that deck instead, created if needed)</span>
              <DeckSelect decks={decks} value={deckId} onChange={setDeckId} />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Kind (unless a column says otherwise)</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as NoteKind)} className={`${control} mt-1 w-full`}>
                {NOTE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-muted">Same front already in the deck</span>
              <select value={duplicates} onChange={(e) => setDuplicates(e.target.value as typeof duplicates)} className={`${control} mt-1 w-full`}>
                <option value="skip">Skip the row</option>
                <option value="update">Update the existing note (keeps its history)</option>
                <option value="create">Create it anyway</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-muted">Tags added to every note</span>
              <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="import::2026-10" className={`${control} mt-1 w-full`} />
            </label>
          </div>

          <div className="flex items-center gap-3">
            {progress && <span className="text-muted">{progress}</span>}
            <button
              type="button"
              disabled={pending || !deckId || !cols.includes("front") || body.length === 0}
              onClick={run}
              className="ml-auto rounded-md bg-accent px-4 py-2 text-white disabled:opacity-50"
            >
              Import {body.length} row{body.length === 1 ? "" : "s"}
            </button>
          </div>
        </>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}
      {report && (
        <div className="rounded-lg border border-line bg-surface p-4">
          <p>
            <span className="font-medium">{report.created}</span> created · <span className="font-medium">{report.updated}</span> updated ·{" "}
            <span className="font-medium">{report.skipped}</span> skipped as duplicates · <span className="font-medium">{report.errors.length}</span> refused
          </p>
          {report.errors.length > 0 && (
            <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto text-xs text-muted">
              {report.errors.slice(0, 200).map((e, i) => (
                <li key={i}>
                  Line {e.row}: {e.error}
                </li>
              ))}
            </ul>
          )}
          <Link href={`/flashcards/browse?deck=${deckId}`} className="mt-3 inline-block text-accent hover:underline">
            Browse the deck →
          </Link>
        </div>
      )}
    </main>
  );
}
