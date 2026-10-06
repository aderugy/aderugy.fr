/**
 * Pure backlog rules shared by the UI's server actions and the Claude connector.
 *
 * Nothing here touches the database: it decides what a category reference
 * means, what a deadline is, and in what order tasks are listed. The callers
 * own the queries.
 */

/** A category with its full path, as the `categories_with_path` view returns it. */
export type CategoryPathRow = {
  id: string;
  parent_id: string | null;
  name: string;
  /** `poker > grind` — names joined with " > " from the root down. */
  path: string;
  archived: boolean;
};

export type CategoryResolution =
  | { ok: true; id: string; path: string }
  | { ok: false; error: string; candidates: string[] };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Canonical form of a path for comparison: lower case, single spaces, and
 * " > " between segments. "/" is accepted as a separator too, since that is
 * what people type when they are not looking at the UI.
 */
export function normalizePath(ref: string): string {
  return ref
    .split(/\s*[>/]\s*/)
    .map((s) => s.trim().replace(/\s+/g, " ").toLowerCase())
    .filter(Boolean)
    .join(" > ");
}

function lastSegment(path: string): string {
  const parts = path.split(" > ");
  return parts[parts.length - 1];
}

/** Levenshtein distance, small strings only — category names. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = up;
    }
  }
  return prev[b.length];
}

/**
 * Turn what Claude (or a person) wrote into one category id.
 *
 * Accepted, in order: an id; a full path (`poker > grind`); a path suffix
 * that is unique (`scia > nlp` for `studies > scia > nlp`); a bare leaf name
 * that is unique (`grind`). Archived categories are never targets — they are
 * hidden from the backlog, so work filed there would vanish.
 *
 * Never creates anything. On failure the error lists the closest live paths so
 * the caller can retry or ask.
 */
export function resolveCategoryRef(
  categories: CategoryPathRow[],
  ref: string,
): CategoryResolution {
  const raw = ref.trim();
  if (!raw) {
    return { ok: false, error: "A category is required.", candidates: [] };
  }

  categories = withInheritedArchive(categories);
  const live = categories.filter((c) => !c.archived);

  if (isUuid(raw)) {
    const hit = categories.find((c) => c.id === raw);
    if (hit && !hit.archived) return { ok: true, id: hit.id, path: hit.path };
    if (hit) {
      return {
        ok: false,
        error: `Category "${hit.path}" is archived.`,
        candidates: [],
      };
    }
    return { ok: false, error: `No category with id ${raw}.`, candidates: [] };
  }

  const wanted = normalizePath(raw);
  const norm = live.map((c) => ({ c, p: normalizePath(c.path) }));

  const exact = norm.filter((x) => x.p === wanted);
  if (exact.length === 1) {
    return { ok: true, id: exact[0].c.id, path: exact[0].c.path };
  }

  const suffix = norm.filter((x) => x.p.endsWith(` > ${wanted}`));
  if (exact.length === 0 && suffix.length === 1) {
    return { ok: true, id: suffix[0].c.id, path: suffix[0].c.path };
  }
  if (suffix.length > 1 || exact.length > 1) {
    const paths = [...exact, ...suffix].map((x) => x.c.path);
    return {
      ok: false,
      error: `"${raw}" matches several categories; use the full path.`,
      candidates: [...new Set(paths)].sort(),
    };
  }

  const archivedHit = categories.find(
    (c) => c.archived && normalizePath(c.path) === wanted,
  );
  if (archivedHit) {
    return {
      ok: false,
      error: `Category "${archivedHit.path}" is archived.`,
      candidates: [],
    };
  }

  return {
    ok: false,
    error: `No category matches "${raw}". Categories are not created automatically.`,
    candidates: closestPaths(live, wanted),
  };
}

/**
 * Archiving a category hides its whole subtree, but the flag is stored on the
 * one node. Propagate it so a child of an archived parent counts as archived.
 */
export function withInheritedArchive(categories: CategoryPathRow[]): CategoryPathRow[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const memo = new Map<string, boolean>();
  const archived = (c: CategoryPathRow, depth = 0): boolean => {
    const known = memo.get(c.id);
    if (known !== undefined) return known;
    const parent = c.parent_id ? byId.get(c.parent_id) : undefined;
    const value = c.archived || (!!parent && depth < 64 && archived(parent, depth + 1));
    memo.set(c.id, value);
    return value;
  };
  return categories.map((c) => ({ ...c, archived: archived(c) }));
}

/** Up to five live paths that look like what was asked for. */
export function closestPaths(
  categories: CategoryPathRow[],
  wanted: string,
  limit = 5,
): string[] {
  const leaf = lastSegment(wanted);
  const scored = categories
    .map((c) => {
      const p = normalizePath(c.path);
      const name = lastSegment(p);
      let score = editDistance(leaf, name);
      if (name.includes(leaf) || leaf.includes(name)) score -= 2;
      if (p.includes(leaf)) score -= 1;
      return { path: c.path, score };
    })
    .filter((x) => x.score <= Math.max(2, Math.floor(leaf.length / 2)))
    .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((x) => x.path);
}

/** The id itself plus every live or archived descendant. */
export function subtreeOf(categories: CategoryPathRow[], rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const c of categories) {
    if (!c.parent_id) continue;
    const list = children.get(c.parent_id) ?? [];
    list.push(c.id);
    children.set(c.parent_id, list);
  }
  const out = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const child of children.get(id) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        stack.push(child);
      }
    }
  }
  return out;
}

/**
 * A deadline is a calendar date. The backlog UI stores the date input's value
 * as midnight UTC and reads it back with `.slice(0, 10)`, so the connector
 * does exactly the same — a deadline set from Claude shows the same day in
 * the table, and round-trips unchanged.
 */
export function parseDeadline(
  input: string | null | undefined,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (input === null || input === undefined || input.trim() === "") {
    return { ok: true, value: null };
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!m) {
    return { ok: false, error: `Deadline "${input}" must be a date, YYYY-MM-DD.` };
  }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) {
    return { ok: false, error: `Deadline "${input}" is not a real date.` };
  }
  return { ok: true, value: date.toISOString() };
}

/** The date part of a stored deadline, as the UI shows it. */
export function deadlineDate(stored: string | null): string | null {
  return stored ? stored.slice(0, 10) : null;
}

export type SortableTask = {
  priority: number;
  deadline: string | null;
  created_at: string;
};

/** Most urgent first: priority, then nearest deadline, then oldest. */
export function compareTasks(a: SortableTask, b: SortableTask): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const da = a.deadline ? Date.parse(a.deadline) : Infinity;
  const db = b.deadline ? Date.parse(b.deadline) : Infinity;
  if (da !== db) return da - db;
  return Date.parse(a.created_at) - Date.parse(b.created_at);
}

export const TASK_LIMITS = {
  minMinutes: 5,
  maxMinutes: 1440,
  maxDescription: 2000,
  maxNotes: 20000,
} as const;
