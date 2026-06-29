import { streamJsonl, readJsonlSlice } from "./jsonl";
import {
  classifyUserRecord,
  isAssistantRecord,
  isUserRecord,
  type AssistantRecord,
  type ContentBlock,
  type SessionRecord,
  type UserRecord,
} from "./records";
import type { SessionMeta, TurnDetail, TurnRef } from "./types";

const SUMMARY_LEN = 140;

/**
 * Strip Claude Code's command/caveat wrappers and condense whitespace so we
 * can show a 1-line preview for a user turn.
 */
function condenseText(text: string): string {
  let t = text;
  t = t.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "").trim();
  t = t.replace(/<command-name>([^<]*)<\/command-name>/g, "/$1").trim();
  t = t.replace(/<command-message>([^<]*)<\/command-message>/g, "").trim();
  t = t.replace(/<command-args>([^<]*)<\/command-args>/g, "$1").trim();
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function truncate(s: string, n = SUMMARY_LEN): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

function extractText(blocks: ContentBlock[] | string | undefined): string {
  if (!blocks) return "";
  if (typeof blocks === "string") return blocks;
  return blocks
    .map((b) => {
      if (b.type === "text" && typeof (b as { text: string }).text === "string") {
        return (b as { text: string }).text;
      }
      return "";
    })
    .join(" ");
}

/**
 * One conversation turn during accumulation. A turn starts at a real user
 * prompt and is closed when the next real user prompt appears.
 */
interface AccumulatorTurn {
  index: number;
  role: "user" | "assistant"; // the role that opened the turn
  ts: string | null;
  byteStart: number;
  byteEnd: number;
  // For computing the summary
  userText: string;
  assistantText: string;
  hasThinking: boolean;
  toolNames: string[];
  toolUseIds: string[];
  toolInputs: Record<string, unknown>;
}

/** Build the full turn index for a session JSONL. Single pass, streaming. */
export async function indexSession(filePath: string): Promise<{
  meta: Omit<SessionMeta, "projectId" | "fileMtime" | "fileSize" | "source" | "originHost" | "repoSnapshots">;
  turns: TurnRef[];
}> {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;
  let model: string | null = null;
  let aiTitle: string | null = null;
  let firstPrompt: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let lastUserTs: string | null = null;
  let messageCount = 0;
  let isSidechain = false;

  const turns: AccumulatorTurn[] = [];
  let cur: AccumulatorTurn | null = null;

  const openTurn = (role: "user" | "assistant", ts: string | null, byteStart: number): AccumulatorTurn => {
    if (cur) turns.push(cur);
    cur = {
      index: turns.length,
      role,
      ts,
      byteStart,
      byteEnd: byteStart,
      userText: "",
      assistantText: "",
      hasThinking: false,
      toolNames: [],
      toolUseIds: [],
      toolInputs: {},
    };
    return cur;
  };

  for await (const { value, byteStart, byteEnd } of streamJsonl<SessionRecord>(filePath)) {
    // Capture session-level fields lazily from any record that carries them.
    const anyRec = value as Record<string, unknown>;
    if (!sessionId && typeof anyRec.sessionId === "string") sessionId = anyRec.sessionId;
    if (!cwd && typeof anyRec.cwd === "string") cwd = anyRec.cwd as string;
    if (!gitBranch && typeof anyRec.gitBranch === "string") gitBranch = anyRec.gitBranch as string;
    if (!version && typeof anyRec.version === "string") version = anyRec.version as string;
    if (anyRec.isSidechain === true) isSidechain = true;

    const ts = typeof anyRec.timestamp === "string" ? (anyRec.timestamp as string) : null;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }

    if (value.type === "ai-title") {
      aiTitle = (value as { aiTitle?: string }).aiTitle ?? aiTitle;
      if (cur) cur.byteEnd = byteEnd;
      continue;
    }

    if (isUserRecord(value)) {
      const klass = classifyUserRecord(value as UserRecord);
      if (klass === "prompt") {
        const text = condenseText(extractText(value.message?.content));
        if (!firstPrompt && text.length > 0) firstPrompt = truncate(text, 200);
        messageCount += 1;
        if (ts) lastUserTs = ts;
        cur = openTurn("user", ts, byteStart);
        if (cur) {
          cur.byteEnd = byteEnd;
          cur.userText = text;
        }
        continue;
      }
      if (klass === "tool_result") {
        // attach to current turn (which should be an assistant turn or the user turn that spawned tool calls)
        if (cur) {
          cur.byteEnd = byteEnd;
        } else {
          cur = openTurn("user", ts, byteStart);
        }
        continue;
      }
      // meta — extend current turn boundary if any
      if (cur) cur.byteEnd = byteEnd;
      continue;
    }

    if (isAssistantRecord(value)) {
      messageCount += 1;
      const rec = value as AssistantRecord;
      if (!model && rec.message?.model) model = rec.message.model;
      // If there is no current user turn, start an assistant-led turn (rare; sidechain agent files do this)
      if (!cur) cur = openTurn("assistant", ts, byteStart);
      if (!cur) continue;
      cur.byteEnd = byteEnd;
      const content = rec.message?.content ?? [];
      for (const block of content) {
        if (block.type === "text") {
          const t = (block as { text: string }).text ?? "";
          cur.assistantText += " " + t;
        } else if (block.type === "thinking") {
          cur.hasThinking = true;
        } else if (block.type === "tool_use") {
          const b = block as { name: string; id: string; input: unknown };
          cur.toolNames.push(b.name);
          cur.toolUseIds.push(b.id);
          cur.toolInputs[b.id] = b.input;
        }
      }
      continue;
    }

    // Everything else: housekeeping. Extend current turn boundary so detail fetches include it.
    if (cur) cur.byteEnd = byteEnd;
  }

  if (cur) turns.push(cur);

  const refs: TurnRef[] = turns.map((t) => {
    const summary = buildTurnSummary(t);
    return {
      index: t.index,
      role: t.role,
      ts: t.ts,
      summary,
      byteStart: t.byteStart,
      byteEnd: t.byteEnd,
      hasThinking: t.hasThinking,
      toolNames: t.toolNames,
      subagentSessionIds: detectSubagentIds(t.toolNames, t.toolInputs),
      userText: t.role === "user" ? t.userText : undefined,
    };
  });

  const meta = {
    sessionId: sessionId ?? deriveSessionIdFromPath(filePath),
    filePath,
    isSidechain,
    parentSessionId: null,
    agentId: null,
    cwd,
    gitBranch,
    model,
    version,
    aiTitle,
    firstPrompt,
    summary: aiTitle ?? firstPrompt ?? null,
    messageCount,
    turnCount: refs.length,
    firstTs,
    lastTs,
    lastUserTs,
  };
  return { meta, turns: refs };
}

function buildTurnSummary(t: AccumulatorTurn): string {
  if (t.role === "user") {
    const base = t.userText.length > 0 ? t.userText : "(empty prompt)";
    return truncate(base);
  }
  // assistant turn: prefer assistant text, fall back to tool list
  const text = t.assistantText.trim();
  if (text.length > 0) return truncate(condenseText(text));
  if (t.toolNames.length > 0) {
    const uniq = Array.from(new Set(t.toolNames));
    return truncate(`→ ${uniq.join(", ")}`);
  }
  return "(no content)";
}

function detectSubagentIds(
  toolNames: string[],
  _toolInputs: Record<string, unknown>,
): string[] {
  // Subagents are matched at indexer time by walking <session>/subagents/.
  // The tool_use input doesn't carry the agent_id; the indexer joins them later.
  return toolNames.includes("Agent") || toolNames.includes("Task") ? [] : [];
}

function deriveSessionIdFromPath(filePath: string): string {
  const base = filePath.split("/").pop() ?? "";
  return base.replace(/\.jsonl$/, "");
}

/**
 * Load the full content of a single turn for the UI. Reads only the byte
 * slice covering that turn — no need to re-scan the whole transcript.
 */
export async function loadTurnDetail(
  filePath: string,
  turn: TurnRef,
): Promise<TurnDetail> {
  const records = await readJsonlSlice<SessionRecord>(filePath, turn.byteStart, turn.byteEnd);
  const blocks: ContentBlock[] = [];
  const inlineMarkers: TurnDetail["inlineMarkers"] = [];

  for (const rec of records) {
    if (isUserRecord(rec)) {
      const c = rec.message?.content;
      if (typeof c === "string") {
        blocks.push({ type: "text", text: c });
      } else if (Array.isArray(c)) {
        for (const b of c) blocks.push(b);
      }
      continue;
    }
    if (isAssistantRecord(rec)) {
      const c = rec.message?.content ?? [];
      for (const b of c) blocks.push(b);
      continue;
    }
    inlineMarkers.push({
      type: rec.type,
      subtype: (rec as { subtype?: string }).subtype,
      ts: (rec as { timestamp?: string }).timestamp,
      note: (rec as { aiTitle?: string; permissionMode?: string; slug?: string }).aiTitle
        ?? (rec as { permissionMode?: string }).permissionMode
        ?? (rec as { slug?: string }).slug,
    });
  }

  return {
    index: turn.index,
    role: turn.role,
    ts: turn.ts,
    blocks,
    inlineMarkers,
  };
}
