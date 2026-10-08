// Prints a fresh VAPID key pair for Web Push, in the base64url form both the
// browser and supabase/functions/_shared/webpush.ts expect.
//
//   node scripts/vapid-keys.mjs
//
// Generate once. Rotating them later silently orphans every subscribed device
// until it is turned on again from the settings page.

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
const publicKey = Buffer.from(raw).toString("base64url");

console.log(`# Vercel (all environments)
NEXT_PUBLIC_VAPID_PUBLIC_KEY=${publicKey}

# Supabase Edge Function secrets
supabase secrets set VAPID_PUBLIC_KEY=${publicKey}
supabase secrets set VAPID_PRIVATE_KEY=${d}
supabase secrets set VAPID_SUBJECT=mailto:you@example.com`);
