import { LIMITS, type NoteKind } from "./types";

/**
 * What a note generates and how each card reads. Notes hold Markdown (with
 * KaTeX math and code); cloze gaps are written `{{c1::answer}}` or
 * `{{c1::answer::hint}}`, and may contain braces of their own — LaTeX is full
 * of them — so gaps are found with a scanner that balances braces rather than
 * a regular expression.
 */

export type Gap = {
  /** The N of cN. */
  n: number;
  answer: string;
  hint: string | null;
  /** Offsets of the whole `{{…}}` in the text. */
  start: number;
  end: number;
};

const OPEN = /\{\{c(\d{1,2})::/y;

/** Every cloze gap in a text, in order. Unbalanced gaps are left as text. */
export function findGaps(text: string): Gap[] {
  const gaps: Gap[] = [];
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("{{c", i);
    if (at < 0) break;
    OPEN.lastIndex = at;
    const m = OPEN.exec(text);
    if (!m) {
      i = at + 3;
      continue;
    }
    const bodyStart = at + m[0].length;
    let depth = 0;
    let j = bodyStart;
    let close = -1;
    let split = -1;
    while (j < text.length) {
      const ch = text[j];
      if (ch === "\\" && j + 1 < text.length) {
        j += 2;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        if (depth === 0 && text[j + 1] === "}") {
          close = j;
          break;
        }
        depth = Math.max(0, depth - 1);
      } else if (ch === ":" && text[j + 1] === ":" && depth === 0) {
        split = j;
        j += 2;
        continue;
      }
      j++;
    }
    if (close < 0) break;
    const n = Number(m[1]);
    const answer = text.slice(bodyStart, split >= 0 ? split : close);
    const hint = split >= 0 ? text.slice(split + 2, close) : null;
    if (n >= 1 && n <= 99) gaps.push({ n, answer, hint: hint?.trim() || null, start: at, end: close + 2 });
    i = close + 2;
  }
  return gaps;
}

/** The card ords a note generates: 0 front→back, 1 back→front, n = gap cn. */
export function cardOrds(note: { kind: NoteKind; front: string; back: string }): number[] {
  switch (note.kind) {
    case "basic":
    case "type_answer":
      return [0];
    case "reversed":
      return note.back.trim() ? [0, 1] : [0];
    case "cloze":
      return [...new Set(findGaps(note.front).map((g) => g.n))].sort((a, b) => a - b);
  }
}

/**
 * The text with gap `ord` hidden (question) or highlighted (answer); every
 * other gap shows its answer as plain text.
 */
export function renderCloze(text: string, ord: number, side: "question" | "answer"): string {
  const gaps = findGaps(text);
  let out = "";
  let at = 0;
  for (const g of gaps) {
    out += text.slice(at, g.start);
    if (g.n === ord) {
      out += side === "question" ? `**[${g.hint ?? "…"}]**` : `**${g.answer}**`;
    } else {
      out += g.answer;
    }
    at = g.end;
  }
  return out + text.slice(at);
}

export type Sides = {
  question: string;
  answer: string;
  /** For "type the answer": what the typed text is compared with. */
  expected: string | null;
};

/** How card `ord` of a note reads. `extra` is shown under the answer by the caller. */
export function sidesOf(note: { kind: NoteKind; front: string; back: string }, ord: number): Sides {
  switch (note.kind) {
    case "basic":
      return { question: note.front, answer: note.back, expected: null };
    case "reversed":
      return ord === 1
        ? { question: note.back, answer: note.front, expected: null }
        : { question: note.front, answer: note.back, expected: null };
    case "type_answer":
      return { question: note.front, answer: note.back, expected: plainText(note.back) };
    case "cloze": {
      const answer = renderCloze(note.front, ord, "answer");
      return {
        question: renderCloze(note.front, ord, "question"),
        answer: note.back.trim() ? `${answer}\n\n---\n\n${note.back}` : answer,
        expected: null,
      };
    }
  }
}

/** Markdown down to the words, for comparing a typed answer and for one-line previews. */
export function plainText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/[*_~#>]+/g, "")
    .replace(/\{\{c\d{1,2}::([^}]*?)(::[^}]*)?\}\}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Typed answers compare without case, outer spaces or repeated spaces. */
export function sameAnswer(typed: string, expected: string): boolean {
  const norm = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  return norm(typed) === norm(expected);
}

/** Split, trim, de-duplicate (any case) and check tags. Throws a sentence. */
export function cleanTags(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input : input.split(/[\s,]+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw.map((x) => x.trim()).filter(Boolean)) {
    if (/\s/.test(t) || t.length > LIMITS.tag) throw new Error(`Tag "${t}": one word of at most ${LIMITS.tag} characters.`);
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  if (out.length > LIMITS.tagsPerNote) throw new Error(`At most ${LIMITS.tagsPerNote} tags on a note.`);
  return out;
}

export type NoteInput = {
  kind: NoteKind;
  front: string;
  back: string;
  extra?: string | null;
  source?: string | null;
  tags?: string[] | string;
};

/** Check a note before it is saved. Throws a sentence; returns the cleaned note. */
export function cleanNote(input: NoteInput): {
  kind: NoteKind;
  front: string;
  back: string;
  extra: string | null;
  source: string | null;
  tags: string[];
} {
  const front = input.front.replace(/\r\n/g, "\n").trim();
  const back = (input.back ?? "").replace(/\r\n/g, "\n").trim();
  const extra = input.extra?.replace(/\r\n/g, "\n").trim() || null;
  const source = input.source?.trim() || null;
  if (!front) throw new Error("The front is empty.");
  for (const [v, what] of [
    [front, "Front"],
    [back, "Back"],
    [extra, "Extra"],
  ] as const) {
    if (v && v.length > LIMITS.field) throw new Error(`${what}: at most ${LIMITS.field} characters.`);
  }
  if (source && source.length > LIMITS.source) throw new Error(`Source: at most ${LIMITS.source} characters.`);
  if (input.kind === "cloze") {
    if (findGaps(front).length === 0) throw new Error("A cloze note needs at least one gap, like {{c1::answer}}.");
  } else if (!back) {
    throw new Error("The back is empty.");
  }
  if (input.kind === "type_answer" && plainText(back).length > 200) {
    throw new Error("A typed answer is at most 200 characters; put the explanation in Extra.");
  }
  return { kind: input.kind, front, back, extra, source, tags: cleanTags(input.tags ?? []) };
}

/** The key two notes are duplicates on: the front, without case or spacing. */
export function duplicateKey(front: string): string {
  return plainText(front).toLowerCase();
}
