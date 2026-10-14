/**
 * Small text tools for /flashcards: the typed-answer diff and CSV in and out.
 */

export type DiffPart = { kind: "same" | "missing" | "extra"; text: string };

/**
 * Character diff of a typed answer against the expected one: what matched,
 * what was missing, what was typed in excess. Longest common subsequence,
 * case-insensitive; inputs are short (typed answers are capped at 200).
 */
export function diffAnswer(expected: string, typed: string): DiffPart[] {
  const a = [...expected.slice(0, 400)];
  const b = [...typed.slice(0, 400)];
  const eq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  const n = a.length;
  const m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = eq(a[i], b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], ch: string) => {
    const last = parts.at(-1);
    if (last && last.kind === kind) last.text += ch;
    else parts.push({ kind, text: ch });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) {
      push("same", a[i]);
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      push("missing", a[i++]);
    } else {
      push("extra", b[j++]);
    }
  }
  while (i < n) push("missing", a[i++]);
  while (j < m) push("extra", b[j++]);
  return parts;
}

/** The delimiter of a CSV/TSV text: tab, semicolon or comma, from its first line. */
export function sniffDelimiter(text: string): "\t" | ";" | "," {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const count = (c: string) => first.split(c).length - 1;
  if (count("\t") > 0) return "\t";
  return count(";") > count(",") ? ";" : ",";
}

/**
 * Parse CSV (RFC 4180: quoted fields, doubled quotes, newlines inside quotes).
 * Empty lines are skipped; a BOM is dropped.
 */
export function parseCsv(text: string, delimiter = sniffDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => {
    row.push(field);
    field = "";
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") endRow();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else field += ch;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** One CSV line, quoting what needs it. */
export function toCsvRow(fields: (string | null | undefined)[]): string {
  return fields
    .map((f) => {
      const s = f ?? "";
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}
