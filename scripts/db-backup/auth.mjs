#!/usr/bin/env node
/**
 * One-time: get a Google refresh token for the backup uploads. Run it on your
 * own computer, not in CI.
 *
 *   node scripts/db-backup/auth.mjs <client-id> <client-secret>
 *
 * The client is an OAuth client of type "Desktop app". It asks for
 * `drive.file` only: the token can create and manage the files it uploads,
 * and cannot see anything else in your Drive.
 *
 * Opens nothing by itself: it prints a URL, you approve in the browser, Google
 * redirects to a server this script runs on 127.0.0.1, and it prints the
 * refresh token to store as the GDRIVE_REFRESH_TOKEN secret.
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("usage: node scripts/db-backup/auth.mjs <client-id> <client-secret>");
  process.exit(2);
}

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const state = randomBytes(16).toString("hex");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  if (url.searchParams.get("state") !== state) {
    res.writeHead(400).end("State mismatch.");
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end(`No code: ${url.searchParams.get("error") ?? "unknown error"}`);
    return;
  }

  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const json = await response.json();

  if (!json.refresh_token) {
    res.writeHead(500).end("No refresh token in Google's answer — see the terminal.");
    console.error("Google did not return a refresh token:", json.error ?? json);
    console.error("Revoke the app at https://myaccount.google.com/permissions and run this again.");
  } else {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(
      "Done. You can close this tab and go back to the terminal.",
    );
    console.log("\nGDRIVE_REFRESH_TOKEN:\n");
    console.log(json.refresh_token);
    console.log("\nStore it as a GitHub Actions secret. Do not commit it.");
  }
  server.close();
});

server.listen(0, "127.0.0.1", () => {
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  consent.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    // Forces a refresh token even if you approved this client before.
    prompt: "consent",
    state,
  }).toString();
  console.log("Open this URL in your browser and approve:\n");
  console.log(consent.toString());
  console.log("\nWaiting for Google to redirect back…");
});
