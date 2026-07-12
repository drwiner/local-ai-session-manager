#!/usr/bin/env tsx
/**
 * One-time repair for session origin-host attribution.
 *
 * Early indexing used a first-writer-wins claim with a birthtime heuristic
 * that could not distinguish an actively-syncing session from a local one, so
 * some sessions were attributed to the wrong machine (and stale OS-rename
 * hostnames like "m5.local" vs the Syncthing device name "M5" lingered).
 *
 * This walks every `*.jsonl.host.json` sidecar under the Claude + Codex
 * session dirs, asks Syncthing who actually authored each file, and rewrites
 * the sidecar + the sessions table when they disagree. Files Syncthing has no
 * record of (outside a synced folder, not yet scanned) are left untouched.
 *
 *   pnpm tsx scripts/repair-origin-hosts.ts          # apply
 *   pnpm tsx scripts/repair-origin-hosts.ts --dry-run # report only
 */
import fs from "fs";
import { getDb } from "../src/lib/db";
import {
  loadSyncthingConfig,
  resolveOriginViaSyncthing,
} from "../src/lib/syncthing";

const DRY_RUN = process.argv.includes("--dry-run");
const SIDECAR_SUFFIX = ".host.json";

interface SessionRow {
  session_id: string;
  origin_host: string | null;
  file_path: string;
}

function readSidecarHost(jsonlPath: string): string | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(jsonlPath + SIDECAR_SUFFIX, "utf8"),
    ) as { hostname?: string };
    return typeof parsed.hostname === "string" ? parsed.hostname : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const cfg = loadSyncthingConfig();
  if (!cfg) {
    console.error(
      "Syncthing config not found — cannot determine authoritative origins. Aborting.",
    );
    process.exit(1);
  }
  console.log(
    `Syncthing at ${cfg.baseUrl}; ${cfg.folders.length} folders, ` +
      `${cfg.deviceNames.size} named devices.`,
  );

  const db = getDb();
  // Drive from the DB, not a disk scan: it keys rows by the same session_id
  // the UI reads, and its file_path lets Syncthing answer even for sessions
  // whose JSONL isn't on this disk (its global index still knows the author).
  const rows = db
    .prepare(
      "SELECT session_id, origin_host, file_path FROM sessions WHERE file_path IS NOT NULL",
    )
    .all() as SessionRow[];
  console.log(`Checking ${rows.length} sessions${DRY_RUN ? " (dry run)" : ""}...\n`);

  const updateDb = db.prepare(
    "UPDATE sessions SET origin_host = ? WHERE session_id = ?",
  );

  let fixed = 0;
  let alreadyOk = 0;
  let unknown = 0;

  for (const row of rows) {
    const truth = await resolveOriginViaSyncthing(row.file_path);
    if (!truth) {
      unknown++;
      continue;
    }
    const fileExists = fs.existsSync(row.file_path);
    const sidecarHost = fileExists ? readSidecarHost(row.file_path) : null;
    if (row.origin_host === truth && (!fileExists || sidecarHost === truth)) {
      alreadyOk++;
      continue;
    }

    console.log(`  ${row.session_id}: ${row.origin_host ?? "(unset)"} -> ${truth}`);
    fixed++;

    if (!DRY_RUN) {
      if (row.origin_host !== truth) updateDb.run(truth, row.session_id);
      if (fileExists && sidecarHost !== truth) {
        const payload = JSON.stringify({ hostname: truth, claimedAt: Date.now() });
        try {
          fs.writeFileSync(row.file_path + SIDECAR_SUFFIX, payload);
        } catch (err) {
          console.error(`    ! sidecar write failed: ${(err as Error).message}`);
        }
      }
    }
  }

  console.log(
    `\n${DRY_RUN ? "Would fix" : "Fixed"} ${fixed}, already correct ${alreadyOk}, ` +
      `unknown to Syncthing ${unknown}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
