/**
 * Google Drive, the little of it the backups need: an access token from a
 * refresh token, one folder, resumable uploads, and pruning old copies.
 *
 * Scope is `drive.file`: this client only ever sees the files it created
 * itself, never the rest of the Drive. Every file it makes is tagged with an
 * `appProperties` marker so it finds its folder and its dumps again.
 *
 * No dependencies — Node's own fetch. The base URLs can be overridden for the
 * test (`GDRIVE_OAUTH_URL`, `GDRIVE_API_URL`, `GDRIVE_UPLOAD_URL`).
 */

const OAUTH_URL = process.env.GDRIVE_OAUTH_URL ?? "https://oauth2.googleapis.com/token";
const API_URL = process.env.GDRIVE_API_URL ?? "https://www.googleapis.com/drive/v3";
const UPLOAD_URL = process.env.GDRIVE_UPLOAD_URL ?? "https://www.googleapis.com/upload/drive/v3";

const MARKER = "aderugyDbBackup";
const FOLDER_MIME = "application/vnd.google-apps.folder";

async function check(response, what) {
  if (response.ok) return response;
  const body = await response.text().catch(() => "");
  // Google's error bodies carry no secrets, but keep them short in public logs.
  throw new Error(`${what} failed: HTTP ${response.status} ${body.slice(0, 300)}`);
}

export async function accessToken({ clientId, clientSecret, refreshToken }) {
  const response = await check(
    await fetch(OAUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    }),
    "Google token refresh",
  );
  const json = await response.json();
  if (!json.access_token) throw new Error("Google token refresh returned no access token");
  return json.access_token;
}

function quote(value) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** The backups folder, created on first use. */
export async function ensureFolder(token, name) {
  const q = [
    `mimeType = ${quote(FOLDER_MIME)}`,
    "trashed = false",
    `appProperties has { key=${quote(MARKER)} and value='folder' }`,
  ].join(" and ");
  const found = await check(
    await fetch(`${API_URL}/files?${new URLSearchParams({ q, fields: "files(id,name)", pageSize: "10" })}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    "Folder lookup",
  ).then((r) => r.json());
  if (found.files?.length) return found.files[0].id;

  const created = await check(
    await fetch(`${API_URL}/files?fields=id`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, appProperties: { [MARKER]: "folder" } }),
    }),
    "Folder creation",
  ).then((r) => r.json());
  return created.id;
}

/** Upload bytes into the folder. Resumable, so size is not a concern. */
export async function upload(token, { folderId, name, description, bytes, mimeType = "application/octet-stream" }) {
  const session = await check(
    await fetch(`${UPLOAD_URL}/files?uploadType=resumable&fields=id,name,webViewLink,size`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": mimeType,
        "x-upload-content-length": String(bytes.length),
      },
      body: JSON.stringify({
        name,
        description,
        parents: [folderId],
        appProperties: { [MARKER]: "dump" },
      }),
    }),
    "Upload session",
  );
  const location = session.headers.get("location");
  if (!location) throw new Error("Upload session returned no location");

  const done = await check(
    await fetch(location, {
      method: "PUT",
      headers: { "content-type": mimeType, "content-length": String(bytes.length) },
      body: bytes,
    }),
    "Upload",
  ).then((r) => r.json());
  return done;
}

/** Move all but the newest `keep` dumps to the Drive trash (recoverable for 30 days). */
export async function prune(token, folderId, keep) {
  const q = [
    `${quote(folderId)} in parents`,
    "trashed = false",
    `appProperties has { key=${quote(MARKER)} and value='dump' }`,
  ].join(" and ");
  const files = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q,
      orderBy: "createdTime desc",
      fields: "nextPageToken,files(id,name)",
      pageSize: "100",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await check(
      await fetch(`${API_URL}/files?${params}`, { headers: { authorization: `Bearer ${token}` } }),
      "Listing backups",
    ).then((r) => r.json());
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  const old = files.slice(keep);
  for (const file of old) {
    await check(
      await fetch(`${API_URL}/files/${encodeURIComponent(file.id)}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ trashed: true }),
      }),
      `Trashing ${file.name}`,
    );
  }
  return old.map((f) => f.name);
}
