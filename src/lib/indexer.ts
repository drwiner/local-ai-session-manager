import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { getDb, setMeta } from "./db";
import { decodeProjectFolderHeuristic } from "./decode-path";
import { streamJsonl } from "./jsonl";
import { indexSession } from "./parse-session";
import { indexCodexSession } from "./parse-codex-session";
import { resolveOriginHost } from "./origin-host";
import { resolveRepoSnapshots, readRepoSnapshotsSidecar } from "./git-snapshot";
import { CODEX_SESSIONS_DIR, PROJECTS_DIR } from "./paths";
import type { SessionMeta, SessionSource, TurnRef } from "./types";

interface SessionsIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}

interface SessionsIndexFile {
  version: number;
  originalPath: string;
  entries: SessionsIndexEntry[];
}

interface IndexerStats {
  projectsScanned: number;
  sessionsChanged: number;
  sessionsSkipped: number;
  errors: { file: string; message: string }[];
  durationMs: number;
}

let indexerInFlight: Promise<IndexerStats> | null = null;

export function getRunningIndexer(): Promise<IndexerStats> | null {
  return indexerInFlight;
}

export function runIndexer(): Promise<IndexerStats> {
  if (indexerInFlight) return indexerInFlight;
  indexerInFlight = (async () => {
    try {
      return await runIndexerImpl();
    } finally {
      indexerInFlight = null;
    }
  })();
  return indexerInFlight;
}

async function runIndexerImpl(): Promise<IndexerStats> {
  const t0 = Date.now();
  const stats: IndexerStats = {
    projectsScanned: 0,
    sessionsChanged: 0,
    sessionsSkipped: 0,
    errors: [],
    durationMs: 0,
  };

  if (!fs.existsSync(PROJECTS_DIR)) {
    console.warn(`[indexer] ${PROJECTS_DIR} not found — nothing to index`);
    stats.durationMs = Date.now() - t0;
    return stats;
  }

  const db = getDb();
  const projectEntries = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });

  for (const ent of projectEntries) {
    if (!ent.isDirectory()) continue;
    const projectId = ent.name;
    const projectDir = path.join(PROJECTS_DIR, projectId);
    stats.projectsScanned += 1;

    // Resolve original_path with the most reliable source available, in
    // order: a session's recorded cwd (lossless, round-trips to the encoded
    // folder name) → sessions-index.json → hyphen-decoding heuristic.
    let originalPath = decodeProjectFolderHeuristic(projectId);
    let indexEntries: Map<string, SessionsIndexEntry> = new Map();
    try {
      const idxPath = path.join(projectDir, "sessions-index.json");
      const raw = await fsp.readFile(idxPath, "utf8");
      const parsed = JSON.parse(raw) as SessionsIndexFile;
      if (parsed.originalPath) originalPath = parsed.originalPath;
      for (const e of parsed.entries ?? []) indexEntries.set(e.sessionId, e);
    } catch {
      // no sessions-index.json — fine
    }
    const cwdFromSession = await peekProjectCwd(projectDir);
    if (cwdFromSession && encodeProjectFolder(cwdFromSession) === projectId) {
      originalPath = cwdFromSession;
    }

    db.prepare(
      `INSERT INTO projects(project_id, original_path, dir_path, last_indexed_at)
       VALUES(?,?,?,?)
       ON CONFLICT(project_id) DO UPDATE SET original_path=excluded.original_path, dir_path=excluded.dir_path, last_indexed_at=excluded.last_indexed_at`,
    ).run(projectId, originalPath, projectDir, Date.now());

    // 1. Top-level session JSONLs
    const files = await fsp.readdir(projectDir, { withFileTypes: true });
    for (const f of files) {
      if (!f.isFile()) continue;
      if (!f.name.endsWith(".jsonl")) continue;
      const fp = path.join(projectDir, f.name);
      const sessionId = f.name.replace(/\.jsonl$/, "");
      const seed = indexEntries.get(sessionId);
      try {
        const changed = await indexOneSession({
          projectId,
          sessionId,
          filePath: fp,
          parentSessionId: null,
          agentId: null,
          seed,
        });
        if (changed) stats.sessionsChanged += 1;
        else stats.sessionsSkipped += 1;
      } catch (err) {
        stats.errors.push({ file: fp, message: (err as Error).message });
      }
    }

    // 2. Subagent JSONLs under <projectDir>/<sessionId>/subagents/agent-*.jsonl
    for (const f of files) {
      if (!f.isDirectory()) continue;
      // Only UUID-named dirs are session folders
      if (!/^[0-9a-f-]{36}$/i.test(f.name)) continue;
      const parentSessionId = f.name;
      const subagentDir = path.join(projectDir, parentSessionId, "subagents");
      if (!fs.existsSync(subagentDir)) continue;
      let subFiles: fs.Dirent[] = [];
      try {
        subFiles = await fsp.readdir(subagentDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sf of subFiles) {
        if (!sf.isFile() || !sf.name.endsWith(".jsonl")) continue;
        const fp = path.join(subagentDir, sf.name);
        const agentId = sf.name.replace(/^agent-/, "").replace(/\.jsonl$/, "");
        const sessionId = `${parentSessionId}::${agentId}`;
        try {
          const changed = await indexOneSession({
            projectId,
            sessionId,
            filePath: fp,
            parentSessionId,
            agentId,
            seed: undefined,
          });
          if (changed) stats.sessionsChanged += 1;
          else stats.sessionsSkipped += 1;
        } catch (err) {
          stats.errors.push({ file: fp, message: (err as Error).message });
        }
      }
    }
  }

  await indexCodexSessions(stats);

  setMeta("last_indexed_at", String(Date.now()));
  stats.durationMs = Date.now() - t0;
  console.log(
    `[indexer] scanned ${stats.projectsScanned} projects · ${stats.sessionsChanged} changed · ${stats.sessionsSkipped} skipped · ${stats.errors.length} errors · ${stats.durationMs}ms`,
  );
  if (stats.errors.length > 0) {
    for (const e of stats.errors.slice(0, 5)) console.warn(`[indexer] error in ${e.file}: ${e.message}`);
  }
  return stats;
}

interface IndexOneArgs {
  projectId: string;
  sessionId: string;
  filePath: string;
  parentSessionId: string | null;
  agentId: string | null;
  seed: SessionsIndexEntry | undefined;
  source?: SessionSource;
}

async function indexOneSession(args: IndexOneArgs): Promise<boolean> {
  const stat = await fsp.stat(args.filePath);
  const fileMtime = stat.mtimeMs;
  const fileSize = stat.size;
  const originHost = await resolveOriginHost(args.filePath);

  const db = getDb();
  const existing = db
    .prepare(
      "SELECT file_mtime, file_size, origin_host FROM sessions WHERE session_id = ?",
    )
    .get(args.sessionId) as
    | { file_mtime: number; file_size: number; origin_host: string | null }
    | undefined;

  if (existing && existing.file_mtime === fileMtime && existing.file_size === fileSize) {
    if (originHost !== null && existing.origin_host !== originHost) {
      db.prepare("UPDATE sessions SET origin_host = ? WHERE session_id = ?")
        .run(originHost, args.sessionId);
    }
    const sidecarSnaps = readRepoSnapshotsSidecar(args.filePath);
    if (sidecarSnaps.length > 0) {
      db.prepare("UPDATE sessions SET repo_snapshots = ? WHERE session_id = ?")
        .run(JSON.stringify(sidecarSnaps), args.sessionId);
    }
    return false;
  }

  const source: SessionSource = args.source ?? "claude";
  const { meta, turns } =
    source === "codex"
      ? await indexCodexSession(args.filePath)
      : await indexSession(args.filePath);

  const fullMeta: SessionMeta = {
    sessionId: args.sessionId,
    projectId: args.projectId,
    filePath: args.filePath,
    fileMtime,
    fileSize,
    source,
    isSidechain: args.parentSessionId !== null || meta.isSidechain,
    parentSessionId: args.parentSessionId,
    agentId: args.agentId,
    cwd: meta.cwd ?? null,
    gitBranch: meta.gitBranch ?? args.seed?.gitBranch ?? null,
    model: meta.model ?? null,
    version: meta.version ?? null,
    aiTitle: meta.aiTitle ?? args.seed?.summary ?? null,
    firstPrompt: meta.firstPrompt ?? args.seed?.firstPrompt ?? null,
    summary: meta.aiTitle ?? args.seed?.summary ?? meta.firstPrompt ?? null,
    messageCount: meta.messageCount || (args.seed?.messageCount ?? 0),
    turnCount: meta.turnCount,
    firstTs: meta.firstTs ?? args.seed?.created ?? null,
    lastTs: meta.lastTs ?? args.seed?.modified ?? null,
    lastUserTs: meta.lastUserTs ?? null,
    originHost,
    repoSnapshots: (() => {
      const snaps = resolveRepoSnapshots(args.filePath, meta.cwd ?? null);
      return snaps.length > 0 ? JSON.stringify(snaps) : null;
    })(),
  };

  upsertSession(fullMeta, turns);
  return true;
}

/**
 * Encode a path the way Claude Code does: replace every "/" with "-".
 * The encoded form must equal the project's folder name for the cwd to be
 * a valid (lossless) source of truth for that project's original path.
 */
function encodeProjectFolder(p: string): string {
  return p.replaceAll("/", "-");
}

/**
 * Read just enough of any JSONL under the project (top-level or under
 * <sessionId>/subagents/) to find a record with a `cwd` field. Returns
 * null if no JSONL exists or none carries a cwd.
 */
async function peekProjectCwd(projectDir: string): Promise<string | null> {
  const candidates = await collectJsonlPaths(projectDir);
  for (const fp of candidates) {
    try {
      for await (const { value } of streamJsonl<Record<string, unknown>>(fp)) {
        const cwd = value?.cwd;
        if (typeof cwd === "string" && cwd.length > 0) return cwd;
      }
    } catch {
      // try the next file
    }
  }
  return null;
}

async function collectJsonlPaths(projectDir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(projectDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push(path.join(projectDir, e.name));
    } else if (e.isDirectory() && /^[0-9a-f-]{36}$/i.test(e.name)) {
      const subDir = path.join(projectDir, e.name, "subagents");
      try {
        const subFiles = await fsp.readdir(subDir, { withFileTypes: true });
        for (const sf of subFiles) {
          if (sf.isFile() && sf.name.endsWith(".jsonl")) {
            out.push(path.join(subDir, sf.name));
          }
        }
      } catch {
        // no subagents dir
      }
    }
  }
  return out;
}

function upsertSession(meta: SessionMeta, turns: TurnRef[]) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (
         session_id, project_id, file_path, file_mtime, file_size,
         source, is_sidechain, parent_session_id, agent_id,
         cwd, git_branch, model, version,
         ai_title, first_prompt, summary,
         message_count, turn_count, first_ts, last_ts, last_user_ts,
         origin_host, repo_snapshots
       ) VALUES (
         @session_id, @project_id, @file_path, @file_mtime, @file_size,
         @source, @is_sidechain, @parent_session_id, @agent_id,
         @cwd, @git_branch, @model, @version,
         @ai_title, @first_prompt, @summary,
         @message_count, @turn_count, @first_ts, @last_ts, @last_user_ts,
         @origin_host, @repo_snapshots
       )
       ON CONFLICT(session_id) DO UPDATE SET
         project_id=excluded.project_id,
         file_path=excluded.file_path,
         file_mtime=excluded.file_mtime,
         file_size=excluded.file_size,
         source=excluded.source,
         is_sidechain=excluded.is_sidechain,
         parent_session_id=excluded.parent_session_id,
         agent_id=excluded.agent_id,
         cwd=excluded.cwd,
         git_branch=excluded.git_branch,
         model=excluded.model,
         version=excluded.version,
         ai_title=excluded.ai_title,
         first_prompt=excluded.first_prompt,
         summary=excluded.summary,
         message_count=excluded.message_count,
         turn_count=excluded.turn_count,
         first_ts=excluded.first_ts,
         last_ts=excluded.last_ts,
         last_user_ts=excluded.last_user_ts,
         origin_host=COALESCE(excluded.origin_host, sessions.origin_host),
         repo_snapshots=COALESCE(excluded.repo_snapshots, sessions.repo_snapshots)`,
    ).run({
      session_id: meta.sessionId,
      project_id: meta.projectId,
      file_path: meta.filePath,
      file_mtime: Math.floor(meta.fileMtime),
      file_size: meta.fileSize,
      source: meta.source,
      is_sidechain: meta.isSidechain ? 1 : 0,
      parent_session_id: meta.parentSessionId,
      agent_id: meta.agentId,
      cwd: meta.cwd,
      git_branch: meta.gitBranch,
      model: meta.model,
      version: meta.version,
      ai_title: meta.aiTitle,
      first_prompt: meta.firstPrompt,
      summary: meta.summary,
      message_count: meta.messageCount,
      turn_count: meta.turnCount,
      first_ts: meta.firstTs,
      last_ts: meta.lastTs,
      last_user_ts: meta.lastUserTs,
      origin_host: meta.originHost,
      repo_snapshots: meta.repoSnapshots,
    });

    db.prepare("DELETE FROM turns WHERE session_id = ?").run(meta.sessionId);
    const insertTurn = db.prepare(
      `INSERT INTO turns(session_id, turn_index, role, ts, byte_start, byte_end, summary, has_thinking, tool_names, subagent_session_ids)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const t of turns) {
      insertTurn.run(
        meta.sessionId,
        t.index,
        t.role,
        t.ts,
        t.byteStart,
        t.byteEnd,
        t.summary,
        t.hasThinking ? 1 : 0,
        JSON.stringify(t.toolNames),
        JSON.stringify(t.subagentSessionIds),
      );
    }

    // FTS: delete + re-insert (no virtual UPSERT)
    db.prepare("DELETE FROM sessions_fts WHERE session_id = ?").run(meta.sessionId);
    const projectRow = db
      .prepare("SELECT original_path FROM projects WHERE project_id = ?")
      .get(meta.projectId) as { original_path: string } | undefined;
    db.prepare(
      `INSERT INTO sessions_fts(session_id, summary, first_prompt, ai_title, git_branch, original_path)
       VALUES(?,?,?,?,?,?)`,
    ).run(
      meta.sessionId,
      meta.summary ?? "",
      meta.firstPrompt ?? "",
      meta.aiTitle ?? "",
      meta.gitBranch ?? "",
      projectRow?.original_path ?? "",
    );

    // Per-turn body index — currently user-prompt text only. Skipped for
    // assistant turns and for user turns whose extracted body is empty
    // (e.g. tool-result-only turns) since FTS rows with empty body just
    // bloat the index.
    db.prepare("DELETE FROM turns_fts WHERE session_id = ?").run(meta.sessionId);
    const insertTurnFts = db.prepare(
      `INSERT INTO turns_fts(session_id, turn_index, body) VALUES(?,?,?)`,
    );
    for (const t of turns) {
      if (t.role !== "user") continue;
      const body = (t.userText ?? "").trim();
      if (!body) continue;
      insertTurnFts.run(meta.sessionId, t.index, body);
    }
  });
  tx();
}

/**
 * Walk ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and index each rollout
 * as a session row with source='codex'. Sessions are grouped into projects
 * by cwd using the same `/` → `-` encoding Claude Code uses, so a workspace
 * that's been used by both tools surfaces under a single project entry.
 */
async function indexCodexSessions(stats: IndexerStats): Promise<void> {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return;
  const files: string[] = [];
  await collectCodexJsonl(CODEX_SESSIONS_DIR, files);

  const db = getDb();
  for (const fp of files) {
    try {
      const head = await readCodexHead(fp);
      if (!head) continue;
      const cwd = head.cwd ?? "/unknown";
      const projectId = encodeProjectFolder(cwd);
      db.prepare(
        `INSERT INTO projects(project_id, original_path, dir_path, last_indexed_at)
         VALUES(?,?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET
           original_path=excluded.original_path,
           last_indexed_at=excluded.last_indexed_at`,
      ).run(projectId, cwd, path.dirname(fp), Date.now());

      const changed = await indexOneSession({
        projectId,
        sessionId: head.sessionId,
        filePath: fp,
        parentSessionId: null,
        agentId: null,
        seed: undefined,
        source: "codex",
      });
      if (changed) stats.sessionsChanged += 1;
      else stats.sessionsSkipped += 1;
    } catch (err) {
      stats.errors.push({ file: fp, message: (err as Error).message });
    }
  }
}

async function collectCodexJsonl(root: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const fp = path.join(root, e.name);
    if (e.isDirectory()) {
      await collectCodexJsonl(fp, out);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push(fp);
    }
  }
}

async function readCodexHead(
  filePath: string,
): Promise<{ sessionId: string; cwd: string | null } | null> {
  for await (const { value } of streamJsonl<Record<string, unknown>>(filePath)) {
    if (value?.type !== "session_meta") continue;
    const payload = value.payload as Record<string, unknown> | undefined;
    const id = typeof payload?.id === "string" ? payload.id : null;
    const cwd = typeof payload?.cwd === "string" ? payload.cwd : null;
    if (id) return { sessionId: id, cwd };
    return null;
  }
  return null;
}
