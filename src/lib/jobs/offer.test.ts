/**
 * Unit tests for job-offer extraction and the /jobs rules.
 * Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, extractOffer, findJobPostings } from "./offer";
import { cleanDate, cleanUrl, compareApplications, interviewTitle, isSilent } from "./types";
import { fmtDate, fromLocalInput, toLocalInput } from "./format";

const LONG = "Vous rejoindrez l'équipe Data pour construire des modèles de prédiction. ".repeat(6);

function page(head: string, body: string) {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

test("JSON-LD JobPosting wins over the page around it", () => {
  const ld = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Stage Data Scientist (H/F)",
    hiringOrganization: { "@type": "Organization", name: "Betclic" },
    jobLocation: { "@type": "Place", address: { addressLocality: "Bordeaux", addressCountry: "FR" } },
    employmentType: "INTERN",
    datePosted: "2026-09-20T10:00:00Z",
    validThrough: "2026-12-01",
    description: `<p>${LONG}</p><ul><li>Python</li><li>SQL</li></ul>`,
  };
  const html = page(
    `<title>Jobs | Site</title><script type="application/ld+json">${JSON.stringify(ld)}</script>`,
    `<nav>Menu</nav><main><p>Cookie banner and other noise</p></main>`,
  );
  const r = extractOffer(html);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.offer.source, "json-ld");
  assert.equal(r.offer.title, "Stage Data Scientist (H/F)");
  assert.equal(r.offer.company, "Betclic");
  assert.match(r.offer.markdown, /^# Stage Data Scientist \(H\/F\)/);
  assert.match(r.offer.markdown, /\*\*Location:\*\* Bordeaux, FR/);
  assert.match(r.offer.markdown, /\*\*Apply before:\*\* 2026-12-01/);
  assert.match(r.offer.markdown, /- Python/);
  assert.doesNotMatch(r.offer.markdown, /Cookie banner/);
});

test("JobPosting inside @graph, with HTML escaped twice", () => {
  const ld = {
    "@graph": [
      { "@type": "WebPage", name: "x" },
      { "@type": ["JobPosting"], title: "Quant intern", description: `&lt;p&gt;${LONG}&lt;/p&gt;` },
    ],
  };
  const html = page(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`, "");
  assert.equal(findJobPostings(html).length, 1);
  const r = extractOffer(html);
  assert.ok(r.ok && r.offer.markdown.includes("Vous rejoindrez"));
  assert.ok(r.ok && !r.offer.markdown.includes("&lt;"));
});

test("broken JSON-LD falls back to the page's main content", () => {
  const html = page(
    `<meta property="og:title" content="Research intern — Lab"><script type="application/ld+json">{oops</script>`,
    `<header>Logo</header><main><h2>Mission</h2><p>${LONG}</p><script>track()</script></main><footer>Legal</footer>`,
  );
  const r = extractOffer(html);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.offer.source, "page");
  assert.equal(r.offer.title, "Research intern — Lab");
  assert.match(r.offer.markdown, /^# Research intern — Lab/);
  assert.match(r.offer.markdown, /## Mission/);
  assert.doesNotMatch(r.offer.markdown, /track\(\)|Legal|Logo/);
});

test("a shell page is refused with a sentence", () => {
  const r = extractOffer(page("<title>LinkedIn</title>", `<div id="root"></div><script>app()</script>`));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /Paste the offer/.test(r.error));
});

test("entities", () => {
  assert.equal(decodeEntities("R&amp;D &#233;quipe &#x27;x&#x27; &nbsp;"), "R&D équipe 'x'  ");
});

test("cleanUrl and cleanDate", () => {
  assert.equal(cleanUrl("  "), null);
  assert.equal(cleanUrl("https://jobs.example.com/a?b=1"), "https://jobs.example.com/a?b=1");
  assert.throws(() => cleanUrl("javascript:alert(1)"), /http/);
  assert.throws(() => cleanUrl("not a url"), /not a URL/);
  assert.equal(cleanDate("2027-02-08"), "2027-02-08");
  assert.equal(cleanDate(""), null);
  assert.throws(() => cleanDate("2027-02-30"), /not a real date/);
});

test("list order: open first, further along first, then latest", () => {
  const rows = [
    { id: "a", status: "rejected" as const, updated_at: "2026-10-05T00:00:00Z" },
    { id: "b", status: "applied" as const, updated_at: "2026-10-01T00:00:00Z" },
    { id: "c", status: "interviewing" as const, updated_at: "2026-09-01T00:00:00Z" },
    { id: "d", status: "applied" as const, updated_at: "2026-10-03T00:00:00Z" },
  ];
  assert.deepEqual(rows.sort(compareApplications).map((r) => r.id), ["c", "d", "b", "a"]);
});

test("silence hint", () => {
  const now = new Date("2026-10-30T00:00:00Z");
  assert.equal(isSilent({ status: "applied", applied_on: "2026-10-01", updated_at: "2026-10-01T00:00:00Z" }, now), true);
  assert.equal(isSilent({ status: "applied", applied_on: "2026-10-20", updated_at: "2026-10-20T00:00:00Z" }, now), false);
  assert.equal(isSilent({ status: "interviewing", applied_on: "2026-09-01", updated_at: "2026-09-01T00:00:00Z" }, now), false);
});

test("interview titles", () => {
  assert.equal(interviewTitle("Betclic", "technical"), "Interview · Betclic (technical)");
  assert.equal(interviewTitle("Betclic", "other"), "Interview · Betclic");
});

test("datetime inputs are read and written in Paris time, across DST", () => {
  assert.equal(toLocalInput("2026-10-08T12:00:00Z"), "2026-10-08T14:00");
  assert.equal(fromLocalInput("2026-10-08T14:00"), "2026-10-08T12:00:00.000Z");
  assert.equal(fromLocalInput("2026-12-01T09:30"), "2026-12-01T08:30:00.000Z");
  assert.equal(fromLocalInput("2026-10-25T10:00"), "2026-10-25T09:00:00.000Z");
  assert.equal(fromLocalInput("nope"), "");
  assert.equal(fmtDate("2027-02-08"), "8 Feb");
});
