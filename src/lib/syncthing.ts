import fs from "fs";
import os from "os";
import path from "path";

/**
 * Minimal read-only client for the local Syncthing REST API. We use it to
 * recover the *authoritative* origin machine for a synced session file:
 * Syncthing records which device last modified each file (`global.modifiedBy`
 * in the file-info endpoint), and since a given session JSONL is only ever
 * appended to by the one machine running that Claude session, that device is
 * the true author.
 *
 * This exists because the birthtime-vs-mtime heuristic in origin-host.ts
 * cannot tell an actively-syncing session apart from a local one — Syncthing
 * lands files fast enough that birthtime ≈ mtime — so whichever machine's
 * indexer runs first wrongly claims the session. Syncthing's own metadata has
 * no such ambiguity.
 */

interface SyncthingFolder {
  id: string;
  path: string;
}

interface SyncthingConfig {
  apiKey: string;
  baseUrl: string;
  folders: SyncthingFolder[];
  /** short device id (first segment of the full id, upper-cased) -> device name */
  deviceNames: Map<string, string>;
}

function candidateConfigPaths(): string[] {
  const home = os.homedir();
  return [
    path.join(home, "Library", "Application Support", "Syncthing", "config.xml"),
    path.join(home, ".config", "syncthing", "config.xml"),
    path.join(home, ".local", "state", "syncthing", "config.xml"),
  ];
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function shortDeviceId(fullOrShort: string): string {
  return fullOrShort.split("-")[0].toUpperCase();
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
}

let cachedConfig: SyncthingConfig | null | undefined;

/**
 * Parse the on-disk Syncthing config for the API key, GUI address, folder
 * roots, and device-id→name map. Cached for the life of the process. Returns
 * null when Syncthing isn't installed / configured on this machine.
 */
export function loadSyncthingConfig(): SyncthingConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  cachedConfig = null;

  let xml: string | null = null;
  for (const p of candidateConfigPaths()) {
    try {
      xml = fs.readFileSync(p, "utf8");
      break;
    } catch {
      // try next candidate
    }
  }
  if (!xml) return null;

  const apiKey = xml.match(/<apikey>([^<]+)<\/apikey>/)?.[1]?.trim();
  if (!apiKey) return null;

  const address =
    xml.match(/<gui\b[^>]*>[\s\S]*?<address>([^<]+)<\/address>/)?.[1]?.trim() ??
    "127.0.0.1:8384";
  const baseUrl = `http://${address}`;

  const folders: SyncthingFolder[] = [];
  for (const m of xml.matchAll(/<folder\b[^>]*>/g)) {
    const tag = m[0];
    const id = attr(tag, "id");
    const fpath = attr(tag, "path");
    if (id && fpath) folders.push({ id, path: expandHome(fpath) });
  }

  const deviceNames = new Map<string, string>();
  for (const m of xml.matchAll(/<device\b[^>]*>/g)) {
    const tag = m[0];
    const id = attr(tag, "id");
    const name = attr(tag, "name");
    // Per-folder <device> children carry an id but no name; skip those.
    if (id && name) deviceNames.set(shortDeviceId(id), name);
  }

  cachedConfig = { apiKey, baseUrl, folders, deviceNames };
  return cachedConfig;
}

/** Map an absolute file path to the Syncthing folder + relative path holding it. */
function locateInFolder(
  cfg: SyncthingConfig,
  absPath: string,
): { folderId: string; relPath: string } | null {
  let best: { folderId: string; relPath: string; len: number } | null = null;
  for (const f of cfg.folders) {
    const root = f.path.replace(/\/+$/, "");
    if (absPath === root || absPath.startsWith(root + path.sep)) {
      const rel = path.relative(root, absPath).split(path.sep).join("/");
      if (!best || root.length > best.len) {
        best = { folderId: f.id, relPath: rel, len: root.length };
      }
    }
  }
  return best ? { folderId: best.folderId, relPath: best.relPath } : null;
}

/**
 * Resolve the origin device *name* for a session file via Syncthing, or null
 * if Syncthing is unavailable, the file lives outside a synced folder, or
 * Syncthing has no record of it yet. Never throws.
 */
export async function resolveOriginViaSyncthing(
  absPath: string,
): Promise<string | null> {
  const cfg = loadSyncthingConfig();
  if (!cfg) return null;

  const loc = locateInFolder(cfg, absPath);
  if (!loc) return null;

  try {
    const url =
      `${cfg.baseUrl}/rest/db/file?folder=${encodeURIComponent(loc.folderId)}` +
      `&file=${encodeURIComponent(loc.relPath)}`;
    const res = await fetch(url, {
      headers: { "X-API-Key": cfg.apiKey },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      global?: { modifiedBy?: string; deleted?: boolean };
    };
    const modifiedBy = body.global?.modifiedBy;
    if (!modifiedBy || body.global?.deleted) return null;
    return cfg.deviceNames.get(shortDeviceId(modifiedBy)) ?? null;
  } catch {
    return null;
  }
}

/** Test seam: drop the cached config so a later call re-reads it. */
export function resetSyncthingConfigCache(): void {
  cachedConfig = undefined;
}
