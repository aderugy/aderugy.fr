import TurndownService from "turndown";
import { JOB_LIMITS } from "./types";

/**
 * Turn a job-offer page into Markdown worth keeping.
 *
 * Two sources, best first:
 *   1. schema.org `JobPosting` in a JSON-LD script. Job boards and applicant
 *      tracking systems publish it for search engines, so it is usually there,
 *      and it is the clean version: title, company, place, dates, and the
 *      description without the site around it.
 *   2. The page itself: `<main>` or `<article>` if there is one, the body
 *      otherwise, with navigation, scripts and forms removed.
 *
 * Pure: no fetching here (server/jobs/fetch-offer.ts does that), so it can be
 * tested on saved pages.
 */

export type ExtractedOffer = {
  title: string | null;
  company: string | null;
  markdown: string;
  source: "json-ld" | "page";
};

/** Less than this after cleaning is a shell page: rendered by script, or a login wall. */
export const MIN_OFFER_CHARS = 200;

function turndown(): TurndownService {
  const t = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  t.remove(["script", "style", "noscript", "iframe", "form", "button", "nav", "footer", "header", "aside", "select", "input", "img"]);
  t.remove((node) => node.nodeName.toLowerCase() === "svg");
  return t;
}

function tidy(md: string): string {
  return md
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    // Turndown pads list markers ("-   item"); one space reads and diffs better.
    .replace(/^(\s*)([-*]|\d+\.) {2,}/gm, "$1$2 ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/** Enough entity decoding for text and for HTML that was escaped once more. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return ENTITIES[lower] ?? m;
  });
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

type Json = Record<string, unknown>;

function isJobPosting(node: unknown): node is Json {
  if (!node || typeof node !== "object") return false;
  const type = (node as Json)["@type"];
  return asArray(type as string | string[]).some((t) => typeof t === "string" && t.toLowerCase() === "jobposting");
}

/** Every JobPosting in the page's JSON-LD, wherever it is nested (@graph, arrays). */
export function findJobPostings(html: string): Json[] {
  const found: Json[] = [];
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const stack: unknown[] = [data];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        stack.push(...node);
      } else if (node && typeof node === "object") {
        if (isJobPosting(node)) found.push(node as Json);
        else if ((node as Json)["@graph"]) stack.push((node as Json)["@graph"]);
      }
    }
  }
  return found;
}

function text(v: unknown): string | null {
  if (typeof v === "string") {
    const t = decodeEntities(v).trim();
    return t || null;
  }
  if (v && typeof v === "object" && typeof (v as Json).name === "string") return text((v as Json).name);
  return null;
}

function place(job: Json): string | null {
  const parts = asArray(job.jobLocation as Json | Json[]).map((loc) => {
    const address = (loc?.address ?? loc) as Json | string | undefined;
    if (typeof address === "string") return address;
    if (!address || typeof address !== "object") return null;
    const country = address.addressCountry;
    return [address.addressLocality, address.addressRegion, typeof country === "object" ? (country as Json)?.name : country]
      .map(text)
      .filter(Boolean)
      .join(", ");
  });
  const remote = text(job.jobLocationType)?.toUpperCase() === "TELECOMMUTE" ? "Remote" : null;
  const all = [...new Set([...parts.filter((p): p is string => !!p), ...(remote ? [remote] : [])])];
  return all.length ? all.join(" · ") : null;
}

function day(v: unknown): string | null {
  const t = text(v);
  return t ? t.slice(0, 10) : null;
}

function fromJobPosting(job: Json): ExtractedOffer | null {
  const title = text(job.title);
  const company = text(job.hiringOrganization);
  let description = typeof job.description === "string" ? job.description : "";
  // Some sites escape the HTML once more inside the JSON string.
  if (!/<[a-z]/i.test(description) && /&lt;[a-z]/i.test(description)) {
    description = decodeEntities(description);
  }
  const body = tidy(turndown().turndown(description || ""));
  if (!title && !body) return null;

  const facts = [
    company && `**Company:** ${company}`,
    place(job) && `**Location:** ${place(job)}`,
    asArray(job.employmentType as string | string[]).length > 0 &&
      `**Type:** ${asArray(job.employmentType as string | string[]).map(String).join(", ")}`,
    day(job.datePosted) && `**Posted:** ${day(job.datePosted)}`,
    day(job.validThrough) && `**Apply before:** ${day(job.validThrough)}`,
  ].filter(Boolean);

  const markdown = tidy(
    [title ? `# ${title}` : "", facts.join(" · "), body].filter(Boolean).join("\n\n"),
  );
  return { title, company, markdown, source: "json-ld" };
}

/** Inner HTML of the first `<tag …>` up to its last closing tag — crude, but tolerant. */
function slice(html: string, tag: string): string | null {
  const open = new RegExp(`<${tag}(\\s[^>]*)?>`, "i").exec(html);
  if (!open) return null;
  const close = html.toLowerCase().lastIndexOf(`</${tag}>`);
  if (close <= open.index) return null;
  return html.slice(open.index + open[0].length, close);
}

function meta(html: string, property: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${property}["'][^>]*content\\s*=\\s*["']([^"']*)["']` +
      `|<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${property}["']`,
    "i",
  );
  const m = re.exec(html);
  return m ? text(m[1] ?? m[2]) : null;
}

function fromPage(html: string): ExtractedOffer {
  const title =
    meta(html, "og:title") ?? text(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]) ?? null;
  const company = meta(html, "og:site_name");
  const content = slice(html, "main") ?? slice(html, "article") ?? slice(html, "body") ?? html;
  const body = tidy(turndown().turndown(content.replace(/<head[\s\S]*?<\/head>/i, "")));
  const markdown = tidy([title && !body.startsWith("# ") ? `# ${title}` : "", body].filter(Boolean).join("\n\n"));
  return { title, company, markdown, source: "page" };
}

/** The offer in a page, or the reason there is none worth keeping. */
export function extractOffer(
  html: string,
): { ok: true; offer: ExtractedOffer } | { ok: false; error: string } {
  for (const job of findJobPostings(html)) {
    const offer = fromJobPosting(job);
    if (offer && offer.markdown.length >= MIN_OFFER_CHARS) return { ok: true, offer: clip(offer) };
  }
  const offer = fromPage(html);
  if (offer.markdown.length < MIN_OFFER_CHARS) {
    return {
      ok: false,
      error:
        "The page has almost no text: it is probably built by JavaScript or behind a login. Paste the offer instead.",
    };
  }
  return { ok: true, offer: clip(offer) };
}

function clip(offer: ExtractedOffer): ExtractedOffer {
  if (offer.markdown.length <= JOB_LIMITS.maxOffer) return offer;
  const note = "\n\n… (cut: the page was longer than what is kept)";
  return { ...offer, markdown: offer.markdown.slice(0, JOB_LIMITS.maxOffer - note.length) + note };
}
