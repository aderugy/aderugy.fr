import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { extractOffer, type ExtractedOffer } from "@/lib/jobs/offer";

/**
 * Fetch a job-offer page from the server and extract the offer.
 *
 * The URL comes from Arthur or from Claude, and the request leaves from the
 * server, so it is fenced like any server-side fetch of a user-given address:
 * http(s) only, public addresses only (checked after DNS, and again on every
 * redirect), a time limit and a size limit.
 *
 * Some sites will not serve a server at all (LinkedIn usually asks for a
 * login). That is reported as a sentence, and the page offers to paste the
 * offer instead — Claude can also read it in the browser and store it with
 * set_offer_text.
 */

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;

export type FetchedOffer = { ok: true; offer: ExtractedOffer; url: string } | { ok: false; error: string };

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip);
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return privateV4(v6.slice(7));
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb")
  );
}

async function checkTarget(url: URL): Promise<string | null> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http(s) links can be fetched.";
  if (url.username || url.password) return "Links with credentials are not fetched.";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return "That address is not public.";
  }
  try {
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (addresses.length === 0 || addresses.some((a) => privateAddress(a.address))) {
      return "That address is not public.";
    }
  } catch {
    return `Could not resolve ${host}.`;
  }
  return null;
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(Math.min(size, MAX_BYTES));
  let at = 0;
  for (const c of chunks) {
    all.set(c.subarray(0, Math.min(c.byteLength, all.byteLength - at)), at);
    at += c.byteLength;
    if (at >= all.byteLength) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

export async function fetchOffer(rawUrl: string): Promise<FetchedOffer> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: `"${rawUrl}" is not a URL.` };
  }

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      const problem = await checkTarget(url);
      if (problem) return { ok: false, error: problem };

      const res = await fetch(url, {
        redirect: "manual",
        signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
        },
        cache: "no-store",
      });

      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get("location");
        if (!next || hop >= MAX_REDIRECTS) return { ok: false, error: "The page redirects too many times." };
        url = new URL(next, url);
        continue;
      }
      if (res.status === 401 || res.status === 403 || res.status === 999) {
        return { ok: false, error: `The site refused the server (HTTP ${res.status}) — it wants a browser or a login. Paste the offer instead.` };
      }
      if (!res.ok) return { ok: false, error: `The page answered HTTP ${res.status}.` };
      const type = res.headers.get("content-type") ?? "";
      if (type && !/html|xml|text\/plain/i.test(type)) {
        return { ok: false, error: `That link is not a web page (${type.split(";")[0]}).` };
      }

      const html = await readCapped(res);
      const r = extractOffer(html);
      if (!r.ok) return r;
      return { ok: true, offer: r.offer, url: url.toString() };
    }
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      return { ok: false, error: "The page took too long to answer." };
    }
    return { ok: false, error: `Could not fetch the page: ${e instanceof Error ? e.message : "network error"}.` };
  }
}
