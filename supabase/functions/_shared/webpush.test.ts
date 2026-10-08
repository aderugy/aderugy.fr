import { test } from "node:test";
import assert from "node:assert/strict";
import {
  b64urlDecode,
  b64urlEncode,
  encryptPayload,
  vapidAuthorization,
} from "./webpush.ts";

// RFC 8291, Appendix A.
const rfc = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("base64url round-trips without padding", () => {
  const bytes = new Uint8Array([0, 255, 62, 63, 250, 1]);
  const text = b64urlEncode(bytes);
  assert.doesNotMatch(text, /[+/=]/);
  assert.deepEqual(b64urlDecode(text), bytes);
});

test("encryption matches RFC 8291 Appendix A byte for byte", async () => {
  const body = await encryptPayload(
    { p256dh: rfc.uaPublic, auth: rfc.auth },
    new TextEncoder().encode(rfc.plaintext),
    { asPrivate: rfc.asPrivate, asPublic: rfc.asPublic, salt: b64urlDecode(rfc.salt) },
  );
  assert.equal(b64urlEncode(body), rfc.body);
});

/** The browser's side of RFC 8291, to check a randomly keyed message opens. */
async function decrypt(body: Uint8Array, uaPrivate: string, uaPublic: string, auth: string) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);

  const pub = b64urlDecode(uaPublic);
  const priv = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: b64urlEncode(pub.slice(1, 33)),
      y: b64urlEncode(pub.slice(33)),
      d: uaPrivate,
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, priv, 256));

  const hmac = async (k: Uint8Array, d: Uint8Array) =>
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
        d,
      ),
    );
  const enc = new TextEncoder();
  const join = (...p: Uint8Array[]) => new Uint8Array(p.flatMap((x) => [...x]));
  const one = new Uint8Array([1]);

  const ikm = await hmac(
    await hmac(b64urlDecode(auth), ecdh),
    join(enc.encode("WebPush: info\0"), pub, asPublic, one),
  );
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, join(enc.encode("Content-Encoding: aes128gcm\0"), one))).slice(0, 16);
  const nonce = (await hmac(prk, join(enc.encode("Content-Encoding: nonce\0"), one))).slice(0, 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  assert.equal(padded[padded.length - 1], 2, "last-record delimiter");
  return new TextDecoder().decode(padded.slice(0, -1));
}

test("a freshly keyed message decrypts on the browser's side", async () => {
  const message = JSON.stringify({ title: "Deep work", body: "Starts at 14:00" });
  const body = await encryptPayload(
    { p256dh: rfc.uaPublic, auth: rfc.auth },
    new TextEncoder().encode(message),
  );
  // New ephemeral key and salt each time.
  assert.notEqual(b64urlEncode(body.slice(0, 16)), rfc.salt);
  assert.equal(await decrypt(body, rfc.uaPrivate, rfc.uaPublic, rfc.auth), message);
});

test("VAPID header carries a valid ES256 JWT for the push service origin", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const privateKey = (await crypto.subtle.exportKey("jwk", pair.privateKey)).d!;

  const header = await vapidAuthorization(
    "https://fcm.googleapis.com/fcm/send/abc:def",
    { publicKey, privateKey, subject: "mailto:me@example.com" },
    1_800_000_000,
  );

  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(match, header);
  const [, h, c, s, k] = match;
  assert.equal(k, publicKey);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlDecode(h))), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlDecode(c))), {
    aud: "https://fcm.googleapis.com",
    exp: 1_800_000_000 + 12 * 3600,
    sub: "mailto:me@example.com",
  });

  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pair.publicKey,
    b64urlDecode(s),
    new TextEncoder().encode(`${h}.${c}`),
  );
  assert.ok(ok, "signature verifies with the public key");
});
