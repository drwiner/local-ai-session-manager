import fs from "fs";
import os from "os";

import { resolveOriginViaSyncthing } from "./syncthing";

export const LOCAL_HOST = os.hostname();

interface OriginSidecar {
  hostname: string;
  claimedAt: number;
}

function sidecarPath(jsonlPath: string): string {
  return `${jsonlPath}.host.json`;
}

function readSidecarHost(jsonlPath: string): string | null {
  try {
    const raw = fs.readFileSync(sidecarPath(jsonlPath), "utf8");
    const parsed = JSON.parse(raw) as Partial<OriginSidecar>;
    if (typeof parsed.hostname === "string" && parsed.hostname.length > 0) {
      return parsed.hostname;
    }
  } catch {
    // missing, corrupt, or unreadable
  }
  return null;
}

/**
 * Overwrite the origin sidecar with an authoritative hostname. Unlike the
 * first-writer-wins claim in the heuristic path, this always wins: it exists
 * to correct sidecars that an earlier indexing race attributed to the wrong
 * machine. No-ops when the sidecar already agrees.
 */
function writeAuthoritativeSidecar(jsonlPath: string, hostname: string): void {
  if (readSidecarHost(jsonlPath) === hostname) return;
  const payload: OriginSidecar = { hostname, claimedAt: Date.now() };
  try {
    fs.writeFileSync(sidecarPath(jsonlPath), JSON.stringify(payload));
  } catch {
    // best-effort; a stale sidecar is corrected on the next successful run
  }
}

/**
 * Files whose birthtime is more than this many ms newer than their mtime
 * look like Syncthing imports rather than locally-authored files: the
 * filesystem stamped "created" when the file landed here, but Syncthing
 * preserved the original mtime from the source machine. We refuse to
 * claim those for the local host so the originating machine's indexer
 * can claim them the next time it runs.
 */
const IMPORT_BIRTHTIME_SLACK_MS = 10 * 60 * 1000;

/**
 * Look up the originating host for a session JSONL.
 *
 * Preferred source: Syncthing's own file metadata, which records the device
 * that last modified each synced file. Because a session JSONL is only ever
 * appended to by the single machine running that session, that device is the
 * true author — unambiguous even while the session is actively syncing. When
 * Syncthing answers, we (re)write the sidecar so offline machines and the DB
 * converge on the correct value, healing any earlier misattribution.
 *
 * Fallback (Syncthing not installed, file outside a synced folder, or not yet
 * in Syncthing's index): the legacy first-writer-wins sidecar. The first
 * machine to index a session writes a `<file>.host.json` claiming it; when no
 * sidecar exists we use a birthtime-vs-mtime heuristic to avoid claiming a
 * freshly-synced import for the local host. This path is racy for
 * actively-syncing sessions, which is exactly why Syncthing is preferred.
 *
 * Returns the resolved hostname, or null when it can't be determined.
 */
export async function resolveOriginHost(jsonlPath: string): Promise<string | null> {
  const viaSyncthing = await resolveOriginViaSyncthing(jsonlPath);
  if (viaSyncthing) {
    writeAuthoritativeSidecar(jsonlPath, viaSyncthing);
    return viaSyncthing;
  }

  const sidecarHost = readSidecarHost(jsonlPath);
  if (sidecarHost) return sidecarHost;

  let looksLocal = true;
  try {
    const stat = fs.statSync(jsonlPath);
    if (stat.birthtimeMs - stat.mtimeMs > IMPORT_BIRTHTIME_SLACK_MS) {
      looksLocal = false;
    }
  } catch {
    return null;
  }
  if (!looksLocal) return null;

  const payload: OriginSidecar = { hostname: LOCAL_HOST, claimedAt: Date.now() };
  try {
    fs.writeFileSync(sidecarPath(jsonlPath), JSON.stringify(payload), { flag: "wx" });
    return LOCAL_HOST;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Lost the claim race to another indexer on this machine; read theirs.
      return readSidecarHost(jsonlPath);
    }
    return null;
  }
}
