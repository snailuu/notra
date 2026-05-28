import fs from "node:fs/promises";
import path from "node:path";

import { withStateLock } from "../knowledge/state-lock.js";
import { atomicWriteFile } from "../knowledge/yaml-render.js";

const USER_MEMORY_LIMIT = 50;
const USER_MEMORY_INPUT_LIMIT = 5;
const USER_MEMORY_KIND_MAX_LENGTH = 64;
const USER_MEMORY_FIELD_MAX_LENGTH = 500;
const SECRET_VALUE_PATTERN = /(sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{16,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)/giu;

export interface NormalizedUserMemory {
  kind: string;
  assistant_suggestion: string;
  user_reply: string;
  inferred_preference: string;
  confidence: number;
}

export function normalizeUserMemories(input: Record<string, any>): NormalizedUserMemory[] {
  return [
    ...(Array.isArray(input.userMemories) ? input.userMemories : []),
    ...(input.userMemory ? [input.userMemory] : [])
  ]
    .slice(0, USER_MEMORY_INPUT_LIMIT)
    .filter((memory) => memory && typeof memory === "object")
    .map((memory) => ({
      kind: normalizeUserMemoryField(memory.kind || "user-profile", USER_MEMORY_KIND_MAX_LENGTH) || "user-profile",
      assistant_suggestion: normalizeUserMemoryField(memory.assistantSuggestion || memory.assistant_suggestion || ""),
      user_reply: normalizeUserMemoryField(memory.userReply || memory.user_reply || ""),
      inferred_preference: normalizeUserMemoryField(memory.inferredPreference || memory.inferred_preference || memory.preference || ""),
      confidence: normalizeConfidence(memory.confidence)
    }))
    .filter((memory) => memory.inferred_preference || memory.user_reply || memory.assistant_suggestion);
}

function normalizeUserMemoryField(value: unknown, maxLength = USER_MEMORY_FIELD_MAX_LENGTH): string {
  return String(value || "")
    .replace(SECRET_VALUE_PATTERN, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeConfidence(value: unknown): number {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) {
    return 0.6;
  }
  return Math.max(0, Math.min(confidence, 1));
}

export function buildUserMemoryLines(input: Record<string, any>): string[] {
  const memories = normalizeUserMemories(input);
  if (memories.length === 0) {
    return [];
  }

  return memories.map((memory) =>
    [
      `- 类型：${memory.kind}`,
      memory.assistant_suggestion ? `  - 模型建议：${memory.assistant_suggestion}` : null,
      memory.user_reply ? `  - 用户回应：${memory.user_reply}` : null,
      memory.inferred_preference ? `  - 画像提示：${memory.inferred_preference}` : null
    ]
      .filter(Boolean)
      .join("\n")
  );
}

export function buildUserMemoryId(sessionId: string, memory: NormalizedUserMemory, index: number): string {
  const slug = String(memory.kind || "user-profile")
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `${sessionId}-user-memory-${slug || "profile"}-${index + 1}`;
}

export async function updateUserMemoryIndex(
  knowledgeRoot: string,
  sessionId: string,
  memories: NormalizedUserMemory[]
): Promise<string[]> {
  const memoryPath = path.join(knowledgeRoot, "state", "user-memory.json");
  const createdAt = new Date().toISOString();
  const nextMemories = memories.map((memory, index) => ({
    id: buildUserMemoryId(sessionId, memory, index),
    session_id: sessionId,
    kind: memory.kind,
    assistant_suggestion: memory.assistant_suggestion,
    user_reply: memory.user_reply,
    inferred_preference: memory.inferred_preference,
    confidence: memory.confidence,
    created_at: createdAt
  }));

  await withStateLock(knowledgeRoot, "user-memory", async () => {
    const existing = await readJsonSafe(memoryPath, { updated_at: null, memories: [] });
    const byId = new Map(
      [...(existing.memories || []), ...nextMemories].map((memory: { id: string }) => [memory.id, memory])
    );
    const retainedMemories = retainRecentUserMemories([...byId.values()]);

    await fs.mkdir(path.dirname(memoryPath), { recursive: true });
    await atomicWriteFile(
      memoryPath,
      `${JSON.stringify({ updated_at: createdAt, memories: retainedMemories }, null, 2)}\n`
    );
  });

  return nextMemories.map((memory) => memory.id);
}

function retainRecentUserMemories(memories: any[]): any[] {
  return memories
    .filter((memory) => memory && typeof memory === "object")
    .sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")))
    .slice(-USER_MEMORY_LIMIT);
}

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error: any) {
    if (error instanceof SyntaxError) {
      console.warn(`[notra] 用户画像文件 ${filePath} 解析失败，已回退到默认值：${error.message}`);
      return fallback;
    }
    throw error;
  }
}
