/**
 * Web Push, dependency-free: VAPID (RFC 8292) and aes128gcm payload
 * encryption (RFC 8291, on RFC 8188).
 *
 * Only Web Crypto and `fetch`, so it runs the same under Deno (the Edge
 * Function) and Node (the tests). The usual `web-push` npm package leans on
 * `node:crypto` ECDH, which is exactly the part of Deno's Node compatibility
 * not worth betting reminders on; this file is small enough to test against
 * the RFC's own vector instead.
 */

export type PushSubscriptionKeys = {
  endpoint: string;
  /** Base64url uncompressed P-256 public key of the browser (65 bytes). */
  p256dh: string;
  /** Base64url authentication secret (16 bytes). */
  auth: string;
};

export type VapidKeys = {
  /** Base64url uncompressed P-256 public key (65 bytes) — what the browser gets. */
  publicKey: string;
  /** Base64url private scalar `d` (32 bytes). Never leaves Supabase secrets. */
  privateKey: string;
  /** `mailto:` or `https:` contact the push services can reach. */
  subject: string;
};

export type SendOptions = {
  /** Seconds the push service may hold the message while the device is offline. */
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  /**
   * Replaces an undelivered message with the same topic (≤ 32 base64url
   * characters) — a block moved twice while the phone was off gives one
   * reminder, not two.
   */
  topic?: string;
};

export type SendResult =
  | { ok: true; status: number }
  /** The subscription is dead (404/410): delete it. */
  | { ok: false; gone: true; status: number; message: string }
  | { ok: false; gone: false; status: number; message: string };

// ------------------------------------------------------------------ encoding

const encoder = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Web Crypto wants an ArrayBuffer-backed view; this makes the types agree. */
function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, buf(data)));
}

/** HKDF with a single output block, which is all RFC 8291 ever needs. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

function publicJwk(raw: Uint8Array) {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("Expected an uncompressed P-256 public key");
  return {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(raw.slice(1, 33)),
    y: b64urlEncode(raw.slice(33, 65)),
  };
}

// ------------------------------------------------------------- encryption

export type EncryptFixtures = {
  /** Application-server ECDH key pair, raw — tests only. */
  asPrivate?: string;
  asPublic?: string;
  salt?: Uint8Array;
};

/**
 * The request body for one push: RFC 8188 header (salt, record size, the
 * sender's ephemeral key) followed by a single AES-128-GCM record.
 */
export async function encryptPayload(
  sub: Pick<PushSubscriptionKeys, "p256dh" | "auth">,
  plaintext: Uint8Array,
  fixtures: EncryptFixtures = {},
): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);

  let asPrivateKey: CryptoKey;
  let asPublic: Uint8Array;
  if (fixtures.asPrivate && fixtures.asPublic) {
    asPublic = b64urlDecode(fixtures.asPublic);
    asPrivateKey = await crypto.subtle.importKey(
      "jwk",
      { ...publicJwk(asPublic), d: fixtures.asPrivate, ext: true },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    asPrivateKey = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  }

  const uaKey = await crypto.subtle.importKey(
    "raw",
    buf(uaPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivateKey, 256),
  );

  // RFC 8291 §3.3–3.4
  const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = fixtures.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  // One record: the data, then 0x02 marking it as the last one.
  const padded = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", buf(cek), "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce) }, aesKey, buf(padded)),
  );

  const recordSize = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize);
  header[20] = asPublic.length;
  header.set(asPublic, 21);

  if (padded.length + 16 > recordSize) throw new Error("Push payload too large");
  return concat(header, ciphertext);
}

// ------------------------------------------------------------------- VAPID

/** `Authorization: vapid t=<jwt>, k=<public key>` for one push service. */
export async function vapidAuthorization(
  endpoint: string,
  vapid: VapidKeys,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = b64urlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(
    encoder.encode(
      // Push services reject anything over 24 h; 12 h leaves room for skew.
      JSON.stringify({ aud: audience, exp: nowSeconds + 12 * 3600, sub: vapid.subject }),
    ),
  );
  const signingInput = encoder.encode(`${header}.${claims}`);

  const key = await crypto.subtle.importKey(
    "jwk",
    { ...publicJwk(b64urlDecode(vapid.publicKey)), d: vapid.privateKey, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // Web Crypto already returns r‖s, the JWS form — no DER to unwrap.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, buf(signingInput)),
  );
  return `vapid t=${header}.${claims}.${b64urlEncode(signature)}, k=${vapid.publicKey}`;
}

// -------------------------------------------------------------------- send

export async function sendPush(
  sub: PushSubscriptionKeys,
  payload: unknown,
  vapid: VapidKeys,
  options: SendOptions = {},
): Promise<SendResult> {
  const body = await encryptPayload(sub, encoder.encode(JSON.stringify(payload)));

  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(sub.endpoint, vapid),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(options.ttl ?? 300),
    Urgency: options.urgency ?? "high",
  };
  if (options.topic) headers.Topic = options.topic;

  const res = await fetch(sub.endpoint, { method: "POST", headers, body: buf(body) });
  if (res.ok) return { ok: true, status: res.status };

  const message = (await res.text().catch(() => "")).slice(0, 300) || res.statusText;
  const gone = res.status === 404 || res.status === 410;
  return { ok: false, gone, status: res.status, message };
}
