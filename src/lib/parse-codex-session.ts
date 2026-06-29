import { readJsonlSlice, streamJsonl } from "./jsonl";
import type { ContentBlock } from "./records";
import type { SessionMeta, TurnDetail, TurnRef } from "./types";

const SUMMARY_LEN = 140;

interface CodexRecord {
  type: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

interface CodexMessageContent {
  type: string;
  text?: string;
}

function condense(text: string): string {
  return text
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, n = SUMMARY_LEN): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as CodexMessageContent[])
    .map((b) => (typeof b?.text === "string" ? b.text : ""))
    .join(" ");
}

interface AccumulatorTurn {
  index: number;
  role: "user" | "assistant";
  ts: string | null;
  byteStart: number;
  byteEnd: number;
  userText: string;
  assistantText: string;
  hasThinking: boolean;
  toolNames: string[];
}

/**
 * Build the turn index for a single codex rollout JSONL. Codex emits a
 * mix of `response_item` records (model I/O) and `event_msg` records (UI
 * events). We anchor turns on `event_msg.user_message` since that's the
 * real human prompt — the parallel `response_item.message:user` records
 * often carry only environment-context wrappers.
 */
export async function indexCodexSession(filePath: string): Promise<{
  meta: Omit<SessionMeta, "projectId" | "fileMtime" | "fileSize" | "source" | "originHost" | "repoSnapshots">;
  turns: TurnRef[];
}> {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;
  let model: string | null = null;
  let firstPrompt: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let lastUserTs: string | null = null;
  let messageCount = 0;

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
    };
    return cur;
  };

  for await (const { value, byteStart, byteEnd } of streamJsonl<CodexRecord>(filePath)) {
    const ts = typeof value.timestamp === "string" ? value.timestamp : null;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }

    const payload = value.payload as Record<string, unknown> | undefined;

    if (value.type === "session_meta" && payload) {
      if (!sessionId && typeof payload.id === "string") sessionId = payload.id;
      if (!cwd && typeof payload.cwd === "string") cwd = payload.cwd;
      if (!version && typeof payload.cli_version === "string") version = payload.cli_version;
      const git = payload.git as { branch?: string } | undefined;
      if (!gitBranch && typeof git?.branch === "string") gitBranch = git.branch;
      if (cur) cur.byteEnd = byteEnd;
      continue;
    }

    if (value.type === "turn_context" && payload) {
      if (!cwd && typeof payload.cwd === "string") cwd = payload.cwd as string;
      if (cur) cur.byteEnd = byteEnd;
      continue;
    }

    if (value.type === "event_msg" && payload) {
      const t = payload.type as string | undefined;
      if (t === "user_message") {
        const text = condense(typeof payload.message === "string" ? payload.message : "");
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
      if (t === "agent_message") {
        if (!cur) cur = openTurn("assistant", ts, byteStart);
        if (cur) {
          cur.byteEnd = byteEnd;
          const text = typeof payload.message === "string" ? payload.message : "";
          cur.assistantText += " " + text;
        }
        continue;
      }
      // Other event_msg subtypes (token_count, task_started, task_complete,
      // web_search_end, mcp_tool_call_end) are housekeeping.
      if (cur) cur.byteEnd = byteEnd;
      continue;
    }

    if (value.type === "response_item" && payload) {
      const t = payload.type as string | undefined;
      if (t === "message") {
        const role = payload.role as string | undefined;
        if (role === "assistant") {
          messageCount += 1;
          if (!cur) cur = openTurn("assistant", ts, byteStart);
          if (cur) cur.byteEnd = byteEnd;
        } else {
          // `developer` and `user` (environment_context) — not a turn boundary.
          if (cur) cur.byteEnd = byteEnd;
        }
        continue;
      }
      if (t === "reasoning") {
        if (cur) {
          cur.byteEnd = byteEnd;
          cur.hasThinking = true;
        }
        continue;
      }
      if (t === "function_call") {
        if (cur) {
          cur.byteEnd = byteEnd;
          const name = typeof payload.name === "string" ? payload.name : "tool";
          cur.toolNames.push(name);
        }
        continue;
      }
      if (t === "web_search_call") {
        if (cur) {
          cur.byteEnd = byteEnd;
          cur.toolNames.push("web_search");
        }
        continue;
      }
      // function_call_output and anything else: extend boundary.
      if (cur) cur.byteEnd = byteEnd;
      continue;
    }

    if (cur) cur.byteEnd = byteEnd;
  }

  if (cur) turns.push(cur);

  const refs: TurnRef[] = turns.map((t) => ({
    index: t.index,
    role: t.role,
    ts: t.ts,
    summary: buildSummary(t),
    byteStart: t.byteStart,
    byteEnd: t.byteEnd,
    hasThinking: t.hasThinking,
    toolNames: t.toolNames,
    subagentSessionIds: [],
    userText: t.role === "user" ? t.userText : undefined,
  }));

  const sid = sessionId ?? deriveCodexIdFromPath(filePath);
  return {
    meta: {
      sessionId: sid,
      filePath,
      isSidechain: false,
      parentSessionId: null,
      agentId: null,
      cwd,
      gitBranch,
      model,
      version,
      aiTitle: null,
      firstPrompt,
      summary: firstPrompt,
      messageCount,
      turnCount: refs.length,
      firstTs,
      lastTs,
      lastUserTs,
    },
    turns: refs,
  };
}

function buildSummary(t: AccumulatorTurn): string {
  if (t.role === "user") {
    const base = t.userText.trim() || "(empty prompt)";
    return truncate(base);
  }
  const text = t.assistantText.trim();
  if (text) return truncate(condense(text));
  if (t.toolNames.length > 0) {
    const uniq = Array.from(new Set(t.toolNames));
    return truncate(`→ ${uniq.join(", ")}`);
  }
  return "(no content)";
}

function deriveCodexIdFromPath(filePath: string): string {
  const base = filePath.split("/").pop() ?? "";
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : base.replace(/\.jsonl$/, "");
}

/**
 * Convert a codex byte slice into the same ContentBlock[] shape used for
 * Claude Code turns, so the existing TurnDetail UI can render it.
 */
export async function loadCodexTurnDetail(
  filePath: string,
  turn: TurnRef,
): Promise<TurnDetail> {
  const records = await readJsonlSlice<CodexRecord>(filePath, turn.byteStart, turn.byteEnd);
  const blocks: ContentBlock[] = [];
  const inlineMarkers: TurnDetail["inlineMarkers"] = [];

  for (const rec of records) {
    const payload = rec.payload as Record<string, unknown> | undefined;
    if (!payload) continue;

    if (rec.type === "event_msg") {
      const t = payload.type as string | undefined;
      if (t === "user_message" || t === "agent_message") {
        const msg = typeof payload.message === "string" ? payload.message : "";
        if (msg) blocks.push({ type: "text", text: msg });
      } else if (t === "task_started" || t === "task_complete" || t === "token_count") {
        inlineMarkers.push({ type: t, ts: rec.timestamp });
      }
      continue;
    }

    if (rec.type === "response_item") {
      const t = payload.type as string | undefined;
      if (t === "reasoning") {
        const summary = payload.summary;
        const text = Array.isArray(summary)
          ? (summary as CodexMessageContent[]).map((s) => s?.text ?? "").join("\n")
          : "";
        blocks.push({ type: "thinking", thinking: text || "(encrypted)" });
        continue;
      }
      if (t === "function_call") {
        let input: unknown = payload.arguments;
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
          } catch {
            // keep raw string
          }
        }
        blocks.push({
          type: "tool_use",
          id: (payload.call_id as string) ?? "",
          name: (payload.name as string) ?? "tool",
          input,
        });
        continue;
      }
      if (t === "function_call_output") {
        blocks.push({
          type: "tool_result",
          tool_use_id: (payload.call_id as string) ?? "",
          content: (payload.output as string) ?? "",
        });
        continue;
      }
      if (t === "web_search_call") {
        blocks.push({
          type: "tool_use",
          id: "",
          name: "web_search",
          input: payload.action,
        });
        continue;
      }
      // `message` records are duplicated by event_msg.{user,agent}_message;
      // skip them to avoid double-rendering. Keep the developer/system one
      // out too — it's mostly environment_context.
      continue;
    }

    if (rec.type === "turn_context") {
      inlineMarkers.push({ type: "turn_context", ts: rec.timestamp });
    }
  }

  return {
    index: turn.index,
    role: turn.role,
    ts: turn.ts,
    blocks,
    inlineMarkers,
  };
}
