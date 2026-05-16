#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProjectGraphArtifacts } from "../graph/build.js";
import { normalizeEvidencePaths } from "../knowledge/evidence.js";
import { parseFrontmatterBlock } from "../knowledge/graph-model.js";
import {
  buildObsidianLinkSection,
  createLogEvent,
  refreshObsidianVault
} from "../obsidian/vault.js";

const VALID_NODE_TYPES = new Set(["practice", "option", "context", "constraint", "rule"]);
const NODE_ID_PATTERN = /^[a-zA-Z0-9\u4e00-\u9fff][a-zA-Z0-9\u4e00-\u9fff_.-]*$/;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9\u4e00-\u9fff][a-zA-Z0-9\u4e00-\u9fff_.-]*$/;
const USER_MEMORY_LIMIT = 50;
const USER_MEMORY_INPUT_LIMIT = 5;
const USER_MEMORY_KIND_MAX_LENGTH = 64;
const USER_MEMORY_FIELD_MAX_LENGTH = 500;
const USER_MEMORY_LOCK_RETRIES = 50;
const USER_MEMORY_LOCK_RETRY_MS = 20;
const USER_MEMORY_LOCK_STALE_MS = 30000;
const SECRET_VALUE_PATTERN = /(sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{16,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)/giu;

export async function crystallizeSession(projectRootOrKnowledgeRoot, input: Record<string, any> = {}) {
  const knowledgeRoot = await resolveKnowledgeRoot(projectRootOrKnowledgeRoot);
  const writeSession = input.writeSession !== false;
  const incubatingNodes = input.incubatingNodes || [];
  const stableUpdates = input.stableUpdates || [];
  const adoptedNodeIds = input.adoptedNodeIds || [];
  const userMemories = normalizeUserMemories(input);

  if (!writeSession && incubatingNodes.length === 0 && stableUpdates.length === 0 && adoptedNodeIds.length === 0 && userMemories.length === 0) {
    return { mode: "no-op", knowledgeRoot };
  }

  const sessionId = validateSessionId(input.sessionId || buildSessionId(input.topic || "session"));
  let mode = "session-only";

  if (incubatingNodes.length > 0) {
    mode = "session+incubating";
  } else if (stableUpdates.length > 0 || adoptedNodeIds.length > 0) {
    mode = "session+stable-update";
  } else if (userMemories.length > 0) {
    mode = "session+user-memory";
  }

  const userMemoryIds = userMemories.length > 0
    ? await updateUserMemoryIndex(knowledgeRoot, sessionId, userMemories)
    : [];

  if (writeSession) {
    await writeSessionDocument(knowledgeRoot, sessionId, input);
  }

  if (incubatingNodes.length > 0) {
    for (const node of incubatingNodes) {
      await writeKnowledgeNode(knowledgeRoot, {
        ...node,
        maturity: "incubating",
        status: node.status || "active",
        session_refs: dedupeValues([...(node.session_refs || []), sessionId])
      });
    }
  }

  if (stableUpdates.length > 0) {
    for (const update of stableUpdates) {
      await applyStableUpdate(knowledgeRoot, update, sessionId);
    }
  }

  let graphArtifacts = null;
  if (adoptedNodeIds.length > 0 || incubatingNodes.length > 0 || stableUpdates.length > 0) {
    await updateUsageIndex(knowledgeRoot, {
      sessionId,
      adoptedNodeIds,
      mentionedNodeIds: dedupeValues([
        ...incubatingNodes.map((node) => node.id),
        ...stableUpdates.map((node) => node.id),
        ...adoptedNodeIds
      ])
    });
    graphArtifacts = await buildProjectGraphArtifacts(knowledgeRoot);
  }

  await updateRuntimeState(knowledgeRoot, sessionId, mode);
  await refreshObsidianVault(knowledgeRoot, {
    graph: graphArtifacts?.graph,
    event: createLogEvent("notra:crystallize", `结晶会话 ${sessionId}`, {
      mode,
      adopted: adoptedNodeIds,
      incubating: incubatingNodes.map((node) => node.id),
      updated: stableUpdates.map((node) => node.id),
      userMemory: userMemoryIds
    })
  });

  return {
    mode,
    knowledgeRoot,
    sessionId,
    incubatingNodeIds: incubatingNodes.map((node) => node.id),
    updatedNodeIds: stableUpdates.map((node) => node.id),
    adoptedNodeIds,
    userMemoryIds
  };
}

export async function loadCrystallizeCliInput(projectRootOrKnowledgeRoot, cliArgs = [], defaults = {}) {
  const args = [...cliArgs].filter((arg) => arg !== undefined && arg !== null);
  const defaultInput = {
    topic: "manual-crystallize",
    title: "手动结晶",
    decisionSummary: "手动执行了一次项目知识结晶。",
    ...defaults
  };

  if (args.length === 0) {
    return defaultInput;
  }

  if (args[0] === "--input" || args[0] === "-i") {
    if (!args[1]) {
      throw new Error("缺少结晶输入 JSON 文件路径");
    }
    return {
      ...defaultInput,
      ...(await readCrystallizeInputFile(projectRootOrKnowledgeRoot, args[1]))
    };
  }

  const inputPath = await resolveExistingInputFile(projectRootOrKnowledgeRoot, args[0]);
  if (inputPath) {
    return {
      ...defaultInput,
      ...(await readJson(inputPath, {}))
    };
  }

  return {
    ...defaultInput,
    topic: args.join(" ")
  };
}

async function resolveKnowledgeRoot(projectRootOrKnowledgeRoot) {
  const resolved = path.resolve(projectRootOrKnowledgeRoot || process.cwd());
  if (await exists(path.join(resolved, "project-profile.md"))) {
    return resolved;
  }

  const projectKnowledgeRoot = path.join(resolved, ".notra");
  if (await exists(path.join(projectKnowledgeRoot, "project-profile.md"))) {
    return projectKnowledgeRoot;
  }

  throw new Error(`未找到 .notra: ${resolved}`);
}

async function readCrystallizeInputFile(projectRootOrKnowledgeRoot, inputFilePath) {
  const resolvedInputPath = await resolveExistingInputFile(projectRootOrKnowledgeRoot, inputFilePath);
  if (!resolvedInputPath) {
    throw new Error(`未找到结晶输入 JSON: ${inputFilePath}`);
  }

  const input = await readJson(resolvedInputPath, {});
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new Error(`结晶输入 JSON 必须是对象: ${resolvedInputPath}`);
  }
  return input;
}

async function resolveExistingInputFile(projectRootOrKnowledgeRoot, inputFilePath) {
  const candidates = buildInputPathCandidates(projectRootOrKnowledgeRoot, inputFilePath);

  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildInputPathCandidates(projectRootOrKnowledgeRoot, inputFilePath) {
  if (path.isAbsolute(inputFilePath)) {
    return [inputFilePath];
  }

  const resolvedProjectPath = path.resolve(projectRootOrKnowledgeRoot || process.cwd());
  return dedupeValues([
    path.resolve(process.cwd(), inputFilePath),
    path.resolve(resolvedProjectPath, inputFilePath),
    path.resolve(resolvedProjectPath, ".notra", inputFilePath)
  ]);
}

function buildSessionId(topic) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = String(topic || "session")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `session-${date}-${slug || "session"}`;
}

async function writeSessionDocument(knowledgeRoot, sessionId, input) {
  const touchedFiles = normalizeEvidencePaths(input.touchedFiles || []);
  const sessionPath = assertInsideKnowledgeRoot(
    knowledgeRoot,
    path.join(knowledgeRoot, "sessions", `${validateSessionId(sessionId)}.md`)
  );
  const frontmatter = {
    id: sessionId,
    type: "session",
    title: input.title || sessionId,
    date: extractDateFromSessionId(sessionId),
    topic: input.topic || "session",
    decision_summary: input.decisionSummary || "本轮未形成新的稳定知识。",
    touched_files: touchedFiles,
    derived_nodes: dedupeValues([
      ...(input.incubatingNodes || []).map((node) => node.id),
      ...(input.stableUpdates || []).map((node) => node.id)
    ]),
    adopted_nodes: dedupeValues(input.adoptedNodeIds || []),
    user_memory_ids: normalizeUserMemories(input).map((memory, index) => buildUserMemoryId(sessionId, memory, index)),
    status: "recorded"
  };
  const userMemoryLines = buildUserMemoryLines(input);
  const body = {
    Goal: [input.goal || input.title || input.topic || "记录本轮任务"],
    Changes: [input.decisionSummary || "本轮未形成新的稳定知识。"],
    Crystallization: [buildCrystallizationLine(input)],
    ...(userMemoryLines.length > 0 ? { "User Memory": userMemoryLines } : {})
  };

  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await fs.writeFile(sessionPath, renderMarkdownDocument(frontmatter, body), "utf8");
}

function normalizeUserMemories(input) {
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

function normalizeUserMemoryField(value, maxLength = USER_MEMORY_FIELD_MAX_LENGTH) {
  return String(value || "")
    .replace(SECRET_VALUE_PATTERN, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeConfidence(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) {
    return 0.6;
  }
  return Math.max(0, Math.min(confidence, 1));
}

function buildUserMemoryLines(input) {
  const memories = normalizeUserMemories(input);
  if (memories.length === 0) {
    return [];
  }

  return memories.map((memory) => [
    `- 类型：${memory.kind}`,
    memory.assistant_suggestion ? `  - 模型建议：${memory.assistant_suggestion}` : null,
    memory.user_reply ? `  - 用户回应：${memory.user_reply}` : null,
    memory.inferred_preference ? `  - 画像提示：${memory.inferred_preference}` : null
  ].filter(Boolean).join("\n"));
}

function buildUserMemoryId(sessionId, memory, index) {
  const slug = String(memory.kind || "user-profile")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `${sessionId}-user-memory-${slug || "profile"}-${index + 1}`;
}

async function updateUserMemoryIndex(knowledgeRoot, sessionId, memories) {
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

  await withUserMemoryLock(knowledgeRoot, async () => {
    const existing = await readJson(memoryPath, { updated_at: null, memories: [] });
    const byId = new Map([...(existing.memories || []), ...nextMemories].map((memory) => [memory.id, memory]));
    const retainedMemories = retainRecentUserMemories([...byId.values()]);

    await fs.mkdir(path.dirname(memoryPath), { recursive: true });
    await fs.writeFile(
      memoryPath,
      `${JSON.stringify({ updated_at: createdAt, memories: retainedMemories }, null, 2)}\n`,
      "utf8"
    );
  });

  return nextMemories.map((memory) => memory.id);
}

async function withUserMemoryLock(knowledgeRoot, callback) {
  const lockPath = path.join(knowledgeRoot, "state", ".user-memory.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt <= USER_MEMORY_LOCK_RETRIES; attempt += 1) {
    try {
      await fs.mkdir(lockPath);
      await writeUserMemoryLockMetadata(lockPath);
      try {
        return await callback();
      } finally {
        await fs.rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      const removedStaleLock = await removeStaleUserMemoryLock(lockPath);
      if (!removedStaleLock && attempt === USER_MEMORY_LOCK_RETRIES) {
        throw new Error(`用户画像写入锁等待超时: ${lockPath}`);
      }
      await delay(USER_MEMORY_LOCK_RETRY_MS);
    }
  }
}

async function writeUserMemoryLockMetadata(lockPath) {
  await fs.writeFile(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
}

async function removeStaleUserMemoryLock(lockPath) {
  try {
    const stats = await fs.stat(lockPath);
    if (Date.now() - stats.mtimeMs <= USER_MEMORY_LOCK_STALE_MS) {
      return false;
    }
    await fs.rm(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

function retainRecentUserMemories(memories) {
  return memories
    .filter((memory) => memory && typeof memory === "object")
    .sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")))
    .slice(-USER_MEMORY_LIMIT);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCrystallizationLine(input) {
  if ((input.incubatingNodes || []).length > 0) {
    return `新增孵化知识：${input.incubatingNodes.map((node) => node.id).join(", ")}`;
  }
  if ((input.stableUpdates || []).length > 0) {
    return `更新稳定知识：${input.stableUpdates.map((node) => node.id).join(", ")}`;
  }
  return "本轮仅记录 session，没有新增知识节点。";
}

async function writeKnowledgeNode(knowledgeRoot, node) {
  validateKnowledgeNodeInput(node);
  const normalizedNode = {
    ...node,
    source_evidence: normalizeEvidencePaths(node.source_evidence || [])
  };
  const nodePath = resolveNodePath(knowledgeRoot, normalizedNode);
  const body = buildNodeBody(normalizedNode);
  await fs.mkdir(path.dirname(nodePath), { recursive: true });
  await fs.writeFile(nodePath, renderMarkdownDocument(normalizedNode, body), "utf8");
}

async function applyStableUpdate(knowledgeRoot, update, sessionId) {
  validateKnowledgeNodeInput(update);
  const nodePath = await findExistingNodePath(knowledgeRoot, update.id, update.type);
  const source = await fs.readFile(nodePath, "utf8");
  const { data, body } = parseFrontmatterBlock(source);
  const sections = parseMarkdownSections(body);
  const frontmatter = {
    ...data,
    ...update,
    id: data.id,
    type: data.type,
    title: update.title || data.title,
    summary: update.summary || data.summary || "",
    session_refs: dedupeValues([...(data.session_refs || []), ...(update.session_refs || []), sessionId]),
    source_evidence: normalizeEvidencePaths([...(data.source_evidence || []), ...(update.source_evidence || [])])
  };

  if (update.summary) {
    sections.Summary = [update.summary];
  }

  await fs.writeFile(nodePath, renderMarkdownDocument(frontmatter, sections), "utf8");
}

async function updateUsageIndex(knowledgeRoot, { sessionId, adoptedNodeIds, mentionedNodeIds }) {
  const usagePath = path.join(knowledgeRoot, "state", "usage-index.json");
  const rawUsage = await readJson(usagePath, {});
  const usageIndex: Record<string, any> = rawUsage.entries || rawUsage;

  for (const nodeId of dedupeValues(mentionedNodeIds)) {
    usageIndex[nodeId] = usageIndex[nodeId] || {
      session_mentions: 0,
      adopted_count: 0,
      last_used_at: extractDateFromSessionId(sessionId),
      last_session_id: sessionId
    };
    usageIndex[nodeId].session_mentions += 1;
    usageIndex[nodeId].last_used_at = extractDateFromSessionId(sessionId);
    usageIndex[nodeId].last_session_id = sessionId;
  }

  for (const nodeId of dedupeValues(adoptedNodeIds)) {
    usageIndex[nodeId] = usageIndex[nodeId] || {
      session_mentions: 0,
      adopted_count: 0,
      last_used_at: extractDateFromSessionId(sessionId),
      last_session_id: sessionId
    };
    usageIndex[nodeId].adopted_count += 1;
    usageIndex[nodeId].last_used_at = extractDateFromSessionId(sessionId);
    usageIndex[nodeId].last_session_id = sessionId;
  }

  await fs.writeFile(usagePath, `${JSON.stringify(usageIndex, null, 2)}\n`, "utf8");
}

async function updateRuntimeState(knowledgeRoot, sessionId, mode) {
  const runtimePath = path.join(knowledgeRoot, "state", "runtime-state.json");
  const runtimeState = await readJson(runtimePath, {});
  runtimeState.initialized = true;
  runtimeState.last_session_id = sessionId;
  runtimeState.last_crystallized_at = new Date().toISOString();
  runtimeState.graph_dirty = false;
  runtimeState.last_graph_build_at = runtimeState.last_graph_build_at || new Date().toISOString();
  await fs.writeFile(runtimePath, `${JSON.stringify(runtimeState, null, 2)}\n`, "utf8");
}

function extractDateFromSessionId(sessionId) {
  const match = String(sessionId).match(/(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || new Date().toISOString().slice(0, 10);
}

async function findExistingNodePath(knowledgeRoot, nodeId, type) {
  const safeNodeId = validateNodeId(nodeId);
  const safeType = validateNodeType(type);
  const candidates = [
    path.join(knowledgeRoot, `${safeType}s`, `${safeNodeId}.md`),
    path.join(knowledgeRoot, "incubating", `${safeType}s`, `${safeNodeId}.md`)
  ].map((candidate) => assertInsideKnowledgeRoot(knowledgeRoot, candidate));

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  throw new Error(`未找到节点文件: ${nodeId}`);
}

function resolveNodePath(knowledgeRoot, node) {
  const safeNodeId = validateNodeId(node.id);
  const safeType = validateNodeType(node.type);
  const baseDirectory =
    node.maturity === "incubating"
      ? path.join(knowledgeRoot, "incubating", `${safeType}s`)
      : path.join(knowledgeRoot, `${safeType}s`);

  return assertInsideKnowledgeRoot(knowledgeRoot, path.join(baseDirectory, `${safeNodeId}.md`));
}

function validateKnowledgeNodeInput(node) {
  validateNodeId(node?.id);
  validateNodeType(node?.type);
}

function validateNodeId(nodeId) {
  const value = String(nodeId || "").trim();
  if (!NODE_ID_PATTERN.test(value)) {
    throw new Error(`非法 nodeId: ${nodeId}`);
  }
  return value;
}

function validateNodeType(type) {
  const value = String(type || "").trim();
  if (!VALID_NODE_TYPES.has(value)) {
    throw new Error(`非法节点类型: ${type}`);
  }
  return value;
}

function validateSessionId(sessionId) {
  const value = String(sessionId || "").trim();
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new Error(`非法 sessionId: ${sessionId}`);
  }
  return value;
}

function assertInsideKnowledgeRoot(knowledgeRoot, candidatePath) {
  const resolvedRoot = path.resolve(knowledgeRoot);
  const resolvedCandidate = path.resolve(candidatePath);
  const relativePath = path.relative(resolvedRoot, resolvedCandidate);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`路径越界: ${candidatePath}`);
  }
  return resolvedCandidate;
}

function buildNodeBody(node) {
  const sections: Record<string, any[]> = {
    Summary: [node.summary]
  };

  if (node.type === "option") {
    sections.Advantages = [
      node.maturity === "incubating" ? "当前仅作为孵化候选。" : "当前可作为稳定默认方案。"
    ];
    sections.Risks = [
      node.maturity === "incubating" ? "尚未形成稳定默认做法。" : "需要在后续任务中持续验证。"
    ];
  } else {
    sections.Evidence = node.source_evidence || [];
  }

  if ((node.source_evidence || []).length > 0 && node.type === "option") {
    sections.Evidence = node.source_evidence;
  }

  const links = buildObsidianLinkSection(node);
  if (links.length > 0) {
    sections.Links = links;
  }

  return sections;
}

function parseMarkdownSections(markdown) {
  const sections: Record<string, string[]> = {};
  let currentTitle = "Summary";
  let buffer: string[] = [];

  for (const line of String(markdown || "").split("\n")) {
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      sections[currentTitle] = trimSectionBuffer(buffer);
      currentTitle = headingMatch[1].trim();
      buffer = [];
      continue;
    }
    buffer.push(line);
  }

  sections[currentTitle] = trimSectionBuffer(buffer);

  return Object.fromEntries(
    Object.entries(sections).filter(([, value]) => value.length > 0)
  );
}

function trimSectionBuffer(buffer) {
  return buffer.map((line) => line.trim()).filter(Boolean);
}

function renderMarkdownDocument(frontmatter, sections) {
  const normalizedFrontmatter = { ...frontmatter };
  delete normalizedFrontmatter.body;

  const lines = ["---", ...serializeYamlObject(normalizedFrontmatter), "---", ""];

  for (const [title, items] of Object.entries(sections) as [string, string[]][]) {
    lines.push(`## ${title}`, "");
    for (const item of items) {
      lines.push(item);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

function serializeYamlObject(value, indentLevel = 0) {
  return Object.entries(value).flatMap(([key, nestedValue]) =>
    serializeYamlEntry(key, nestedValue, indentLevel)
  );
}

function serializeYamlEntry(key, value, indentLevel) {
  const indent = " ".repeat(indentLevel);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${indent}${key}: []`];
    }
    return [`${indent}${key}:`, ...value.map((item) => `${indent}  - ${serializeScalar(item)}`)];
  }

  if (value && typeof value === "object") {
    const childEntries = Object.entries(value);
    if (childEntries.length === 0) {
      return [`${indent}${key}: {}`];
    }
    return [
      `${indent}${key}:`,
      ...childEntries.flatMap(([childKey, childValue]) =>
        serializeYamlEntry(childKey, childValue, indentLevel + 2)
      )
    ];
  }

  return [`${indent}${key}: ${serializeScalar(value)}`];
}

function serializeScalar(value) {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined || value === "") {
    return '""';
  }
  return String(value);
}

function dedupeValues(values): string[] {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

async function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }
    throw error;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isFile(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectRoot = process.argv[2] || process.cwd();
  const input = await loadCrystallizeCliInput(projectRoot, process.argv.slice(3));
  const result = await crystallizeSession(projectRoot, input);
  console.log(JSON.stringify(result, null, 2));
}
