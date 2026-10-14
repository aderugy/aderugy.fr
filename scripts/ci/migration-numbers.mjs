#!/usr/bin/env node
// Refuse two migrations with the same number.
//
// Supabase records a migration by the number before the first "_" (its
// version). Two files sharing it — 0023_flashcards.sql and
// 0023_hidden_external_events.sql — each look fine in their own pull request,
// and the second one to reach main fails to apply. This works out, for each
// open pull request into main, which migration files main would hold once it
// is merged, and sets a commit status on the pull request's head:
//
//   Migration numbers   success | failure
//
// Branch protection on main requires that status, so the merge button stays
// grey while it fails.
//
// Why a commit status rather than only the job's own result: the clash
// usually appears when *another* pull request is merged, and GitHub never
// re-runs a pull request's checks when its base moves. So every push to main
// re-checks every open pull request and updates their status in place.
//
// Usage:
//   node scripts/ci/migration-numbers.mjs pr <number>   one pull request
//   node scripts/ci/migration-numbers.mjs all          every open PR into main
//   add --dry-run to print without setting any status
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo), optionally
// GITHUB_SERVER_URL + GITHUB_RUN_ID for the status link.

export const DIR = "supabase/migrations/";
export const CONTEXT = "Migration numbers";
const BASE = "main";

/** The version Supabase reads from a migration file name, or null. */
export function versionOf(name) {
  const m = /^(\d+)_.+\.sql$/.exec(name);
  return m ? m[1] : null;
}

/** Migration file names (no directory) under supabase/migrations/, top level. */
function migrationName(path) {
  if (!path || !path.startsWith(DIR)) return null;
  const rest = path.slice(DIR.length);
  return rest.includes("/") || !rest.endsWith(".sql") ? null : rest;
}

/**
 * What the migrations folder holds once a pull request is merged.
 * `base` is the list of names on main; `files` is the pull request's file list
 * as the GitHub API returns it ({ filename, status, previous_filename }).
 */
export function afterMerge(base, files) {
  const names = new Set(base);
  const added = new Set();
  for (const f of files) {
    const before = migrationName(f.previous_filename);
    if (before) names.delete(before);
    const name = migrationName(f.filename);
    if (!name) continue;
    if (f.status === "removed") {
      names.delete(name);
    } else {
      names.add(name);
      if (f.status === "added" || f.status === "renamed" || f.status === "copied") added.add(name);
    }
  }
  return { names: [...names].sort(), added };
}

/**
 * Numbers held by more than one file: [{ version, names }].
 * Only clashes involving `mine` are reported when it is given, so a pull
 * request is not blamed for a clash that is already on main.
 */
export function clashes(names, mine = null) {
  const byVersion = new Map();
  for (const name of names) {
    const v = versionOf(name);
    if (v === null) continue;
    if (!byVersion.has(v)) byVersion.set(v, []);
    byVersion.get(v).push(name);
  }
  return [...byVersion]
    .filter(([, list]) => list.length > 1 && (!mine || list.some((n) => mine.has(n))))
    .map(([version, list]) => ({ version, names: list.sort() }))
    .sort((a, b) => a.version.localeCompare(b.version));
}

/** File names without a version Supabase can read, among `mine` (or all). */
export function unnumbered(names, mine = null) {
  return names.filter((n) => versionOf(n) === null && (!mine || mine.has(n)));
}

// ---------------------------------------------------------------- GitHub

const API = "https://api.github.com";

async function gh(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function paged(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await gh(`${path}${sep}per_page=100&page=${page}`);
    if (!batch?.length) return out;
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

async function baseNames(repo) {
  const list = await gh(`/repos/${repo}/contents/${DIR.slice(0, -1)}?ref=${BASE}`);
  return (list ?? []).filter((e) => e.type === "file").map((e) => e.name).filter((n) => n.endsWith(".sql"));
}

function verdict(base, files) {
  const { names, added } = afterMerge(base, files);
  const found = clashes(names, added);
  const bad = unnumbered(names, added);
  if (!found.length && !bad.length) {
    return { state: "success", description: added.size ? "No migration number is used twice" : "No new migration", lines: [] };
  }
  const lines = [
    ...found.map((c) => `Migration ${c.version} is used by ${c.names.join(" and ")}`),
    ...bad.map((n) => `${n} does not start with a number and "_"`),
  ];
  const description = found.length
    ? `Migration ${found.map((c) => c.version).join(", ")} already exists on main — renumber`
    : "A migration file name has no number";
  return { state: "failure", description, lines };
}

async function check(repo, pr, base, { dryRun }) {
  const files = await paged(`/repos/${repo}/pulls/${pr.number}/files`);
  const v = verdict(base, files);
  const tag = v.state === "success" ? "ok  " : "FAIL";
  console.log(`${tag} #${pr.number} ${pr.title} — ${v.description}`);
  for (const l of v.lines) console.log(`       ${l}`);
  if (v.state === "failure" && process.env.GITHUB_ACTIONS) {
    for (const l of v.lines) console.log(`::error title=Migration numbers (#${pr.number})::${l}`);
  }
  if (!dryRun) {
    const run = process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;
    try {
      await gh(`/repos/${repo}/statuses/${pr.head.sha}`, {
        method: "POST",
        body: JSON.stringify({ state: v.state, context: CONTEXT, description: v.description.slice(0, 140), target_url: run }),
      });
    } catch (e) {
      // A pull request from a fork gets a read-only token; the job's own
      // result still says it.
      console.log(`   (could not set the status: ${e.message.split("\n")[0]})`);
    }
  }
  return v.state === "success";
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const [mode, num] = args.filter((a) => !a.startsWith("--"));
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !process.env.GITHUB_TOKEN || !["pr", "all"].includes(mode) || (mode === "pr" && !num)) {
    console.error("usage: GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo migration-numbers.mjs pr <n> | all [--dry-run]");
    process.exit(2);
  }

  const base = await baseNames(repo);
  const onMain = clashes(base);
  for (const c of onMain) console.log(`::warning title=Migration numbers on main::Migration ${c.version} is used by ${c.names.join(" and ")}`);

  if (mode === "pr") {
    const pr = await gh(`/repos/${repo}/pulls/${num}`);
    if (!pr) throw new Error(`no pull request #${num}`);
    if (pr.base.ref !== BASE) {
      console.log(`#${num} goes into ${pr.base.ref}, not ${BASE} — nothing to check.`);
      return;
    }
    const ok = await check(repo, pr, base, { dryRun });
    process.exit(ok ? 0 : 1);
  }

  const open = await paged(`/repos/${repo}/pulls?state=open&base=${BASE}`);
  if (!open.length) console.log("No open pull request into main.");
  for (const pr of open) await check(repo, pr, base, { dryRun });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
