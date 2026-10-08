#!/usr/bin/env node
/**
 * Upload one database dump to Google Drive and prune old ones.
 *
 *   node scripts/db-backup/upload.mjs <dump-file> [description]
 *
 * Env: GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN (required),
 *      GDRIVE_FOLDER_NAME (default "aderugy.fr — database backups"),
 *      BACKUP_KEEP (default 30).
 *
 * Prints the Drive link. Writes a line to $GITHUB_STEP_SUMMARY when set.
 */

import { readFile, appendFile } from "node:fs/promises";
import { basename } from "node:path";
import { accessToken, ensureFolder, prune, upload } from "./drive.mjs";

const [file, description = ""] = process.argv.slice(2);
if (!file) {
  console.error("usage: upload.mjs <dump-file> [description]");
  process.exit(2);
}

const missing = ["GDRIVE_CLIENT_ID", "GDRIVE_CLIENT_SECRET", "GDRIVE_REFRESH_TOKEN"].filter(
  (k) => !process.env[k],
);
if (missing.length) {
  console.error(`Missing secrets: ${missing.join(", ")}. See README → Database backups.`);
  process.exit(1);
}

async function main() {
  const keep = Number(process.env.BACKUP_KEEP ?? 30);
  const folderName = process.env.GDRIVE_FOLDER_NAME ?? "aderugy.fr — database backups";

  const token = await accessToken({
    clientId: process.env.GDRIVE_CLIENT_ID,
    clientSecret: process.env.GDRIVE_CLIENT_SECRET,
    refreshToken: process.env.GDRIVE_REFRESH_TOKEN,
  });
  const folderId = await ensureFolder(token, folderName);
  const bytes = await readFile(file);
  const uploaded = await upload(token, { folderId, name: basename(file), description, bytes });

  if (Number(uploaded.size) !== bytes.length) {
    throw new Error(`Drive stored ${uploaded.size} bytes, expected ${bytes.length}`);
  }

  const trashed = Number.isFinite(keep) && keep > 0 ? await prune(token, folderId, keep) : [];

  const kib = (bytes.length / 1024).toFixed(0);
  console.log(`Uploaded ${uploaded.name} (${kib} KiB) → ${uploaded.webViewLink ?? uploaded.id}`);
  if (trashed.length) console.log(`Moved ${trashed.length} older backup(s) to the Drive trash.`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `### Database backed up`,
        ``,
        `- File: \`${uploaded.name}\` (${kib} KiB)`,
        `- Drive folder: ${folderName}`,
        trashed.length ? `- Older backups moved to the trash: ${trashed.length}` : null,
        ``,
      ]
        .filter((l) => l !== null)
        .join("\n"),
    );
  }
}

main().catch((error) => {
  console.error(`Backup upload failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
