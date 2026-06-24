#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProjectGraphArtifacts } from "../graph/build.js";
import { normalizeEvidencePaths } from "../knowledge/evidence.js";
import { parseFrontmatterBlock } from "../knowledge/graph-model.js";
import {
  assertInsideKnowledgeRoot,
  resolveNodePath,
  validateNodeId,
  validateNodeType,
  validateSessionId
} from "../knowledge/node-path.js";
import { withStateLock } from "../knowledge/state-lock.js";
import { atomicWriteFile, renderMarkdownDocument } from "../knowledge/yaml-render.js";
import {
  buildObsidianLinkSection,
  createLogEvent,
  refreshObsidianVault
} from "../obsidian/vault.js";
import {
  classifyAdoptionSignals,
  extractRecommendedNodeIds,
  loadNodeMapForIds,
  type AdoptionObservation
} from "./adoption-signal.js";
import {
  buildUserMemoryId,
  buildUserMemoryLines,
  normalizeUserMemories,
  updateUserMemoryIndex
} from "./user-memory.js";

export async function crystallizeSession(projectRootOrKnowledgeRoot, input: Record<string, any> = {}) {
  const knowledgeRoot = await resolveKnowledgeRoot(projectRootOrKnowledgeRoot);
  const writeSession = input.writeSession !== false;
  const incubatingNodes = input.incubatingNodes || [];
  const stableUpdates = input.stableUpdates || [];
  // 新字段 adopted 优先，老字段 adoptedNodeIds 兜底
  const adoptedNodeIds = dedupeValues(input.adopted || input.adoptedNodeIds || []);
  const notApplicableNodeIds = dedupeValues(input.notApplicable || []);
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
  let classification = {
    strong: adoptedNodeIds,
    weak: [] as string[],
    notApplicable: notApplicableNodeIds,
    observations: [] as AdoptionObservation[]
  };

  // preflight 命中但 agent 全缺声明（adopted/notApplicable 都空）时，
  // 仍应记录 missing → weak 观测，避免"召回但无信号"的死区
  const recommendedIds = input.preflight ? extractRecommendedNodeIds(input.preflight) : [];
  const hasClassifiableInput =
    adoptedNodeIds.length > 0
    || incubatingNodes.length > 0
    || stableUpdates.length > 0
    || notApplicableNodeIds.length > 0
    || recommendedIds.length > 0;

  if (hasClassifiableInput) {
    // 有 preflight + touchedFiles 时做分类校验；否则沿用旧行为（adopted 全 strong）
    if (input.preflight && Array.isArray(input.touchedFiles)) {
      const normalizedTouched: string[] = (normalizeEvidencePaths(input.touchedFiles || []) || []).map(String);
      const nodeMapIds = dedupeValues([
        ...adoptedNodeIds,
        ...notApplicableNodeIds,
        ...recommendedIds
      ]);
      const nodeMap = await loadNodeMapForIds(knowledgeRoot, nodeMapIds);
      classification = classifyAdoptionSignals({
        preflight: input.preflight,
        agentAdopted: adoptedNodeIds,
        agentNotApplicable: notApplicableNodeIds,
        touchedFiles: normalizedTouched,
        nodeMap
      });
    }

    await updateUsageIndex(knowledgeRoot, {
      sessionId,
      strongNodeIds: classification.strong,
      weakNodeIds: classification.weak,
      notApplicableNodeIds: classification.notApplicable,
      mentionedNodeIds: dedupeValues([
        ...incubatingNodes.map((node) => node.id),
        ...stableUpdates.map((node) => node.id),
        ...adoptedNodeIds,
        ...recommendedIds
      ])
    });
    await appendAdoptionObservations(
      knowledgeRoot,
      sessionId,
      classification.observations,
      Array.isArray(input.touchedFiles) ? input.touchedFiles.length : 0
    );
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
  if (typeof inputFilePath !== "string" || inputFilePath.length === 0 || !inputFilePath.endsWith(".json")) {
    return [];
  }

  if (path.isAbsolute(inputFilePath)) {
    return [path.resolve(inputFilePath)];
  }

  const projectRoot = path.resolve(projectRootOrKnowledgeRoot || process.cwd());
  return dedupeValues([
    path.resolve(process.cwd(), inputFilePath),
    path.resolve(projectRoot, inputFilePath),
    path.resolve(projectRoot, ".notra", inputFilePath)
  ]);
}

function buildSessionId(topic) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = String(topic || "session")
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿-]+/gu, "-")
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
    adopted_nodes: dedupeValues(input.adopted || input.adoptedNodeIds || []),
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
  await atomicWriteFile(sessionPath, renderMarkdownDocument(frontmatter, body));
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
  await withStateLock(knowledgeRoot, "node-write", async () => {
    const nodePath = resolveNodePath(knowledgeRoot, normalizedNode);
    const body = buildNodeBody(normalizedNode);
    await fs.mkdir(path.dirname(nodePath), { recursive: true });
    await atomicWriteFile(nodePath, renderMarkdownDocument(normalizedNode, body));
  });
}

async function applyStableUpdate(knowledgeRoot, update, sessionId) {
  validateKnowledgeNodeInput(update);
  await withStateLock(knowledgeRoot, "node-write", async () => {
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

    await atomicWriteFile(nodePath, renderMarkdownDocument(frontmatter, sections));
  });
}

async function updateUsageIndex(knowledgeRoot, {
  sessionId,
  strongNodeIds = [],
  weakNodeIds = [],
  notApplicableNodeIds = [],
  mentionedNodeIds = []
}: {
  sessionId: string;
  strongNodeIds?: string[];
  weakNodeIds?: string[];
  notApplicableNodeIds?: string[];
  mentionedNodeIds?: string[];
}) {
  const usagePath = path.join(knowledgeRoot, "state", "usage-index.json");
  await withStateLock(knowledgeRoot, "usage-index", async () => {
    const rawUsage = await readJson(usagePath, {});
    const usageIndex: Record<string, any> = rawUsage.entries || rawUsage;
    const sessionDate = extractDateFromSessionId(sessionId);

    for (const nodeId of dedupeValues(mentionedNodeIds)) {
      const entry = ensureUsageEntry(usageIndex, nodeId, sessionId, sessionDate);
      entry.session_mentions += 1;
      // mentioned 仅是被召回/出现过，不刷 last_used_at（保持原"实际活动"语义）
      entry.last_session_id = sessionId;
    }

    for (const nodeId of dedupeValues(strongNodeIds)) {
      const entry = ensureUsageEntry(usageIndex, nodeId, sessionId, sessionDate);
      entry.strong_count = (entry.strong_count ?? entry.adopted_count ?? 0) + 1;
      // 维持 adopted_count 与 strong_count 同步，保证回滚到老代码后晋升判据仍然正确
      entry.adopted_count = entry.strong_count;
      entry.last_used_at = sessionDate;
      entry.last_session_id = sessionId;
    }

    for (const nodeId of dedupeValues(weakNodeIds)) {
      const entry = ensureUsageEntry(usageIndex, nodeId, sessionId, sessionDate);
      entry.weak_count = (entry.weak_count || 0) + 1;
      // weak 通道不刷 last_used_at（与 Phase 2 冷藏语义一致：仅 strong 才算活动）
      entry.last_session_id = sessionId;
    }

    for (const nodeId of dedupeValues(notApplicableNodeIds)) {
      const entry = ensureUsageEntry(usageIndex, nodeId, sessionId, sessionDate);
      entry.not_applicable_count = (entry.not_applicable_count || 0) + 1;
      entry.last_session_id = sessionId;
    }

    await fs.mkdir(path.dirname(usagePath), { recursive: true });
    await atomicWriteFile(usagePath, `${JSON.stringify(usageIndex, null, 2)}\n`);
  });
}

function ensureUsageEntry(usageIndex: Record<string, any>, nodeId: string, sessionId: string, sessionDate: string) {
  if (!usageIndex[nodeId]) {
    usageIndex[nodeId] = {
      session_mentions: 0,
      adopted_count: 0,
      strong_count: 0,
      weak_count: 0,
      not_applicable_count: 0,
      last_used_at: null,
      last_session_id: sessionId
    };
  }
  const entry = usageIndex[nodeId];
  if (entry.strong_count == null) {
    entry.strong_count = entry.adopted_count || 0;
  }
  if (entry.weak_count == null) {
    entry.weak_count = 0;
  }
  if (entry.not_applicable_count == null) {
    entry.not_applicable_count = 0;
  }
  return entry;
}

async function appendAdoptionObservations(
  knowledgeRoot: string,
  sessionId: string,
  observations: AdoptionObservation[],
  touchedFilesCount: number
) {
  if (!observations || observations.length === 0) {
    return;
  }
  const logPath = path.join(knowledgeRoot, "state", "adoption_observations.jsonl");
  const ts = new Date().toISOString();
  const lines = observations
    .map((observation) => JSON.stringify({
      ts,
      session_id: sessionId,
      touched_files_count: touchedFilesCount,
      ...observation
    }))
    .join("\n") + "\n";
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, lines, "utf8");
}

async function updateRuntimeState(knowledgeRoot, sessionId, mode) {
  const runtimePath = path.join(knowledgeRoot, "state", "runtime-state.json");
  await withStateLock(knowledgeRoot, "runtime-state", async () => {
    const runtimeState = await readJson(runtimePath, {});
    runtimeState.initialized = true;
    runtimeState.last_session_id = sessionId;
    runtimeState.last_crystallized_at = new Date().toISOString();
    runtimeState.graph_dirty = false;
    runtimeState.last_graph_build_at = runtimeState.last_graph_build_at || new Date().toISOString();
    await fs.mkdir(path.dirname(runtimePath), { recursive: true });
    await atomicWriteFile(runtimePath, `${JSON.stringify(runtimeState, null, 2)}\n`);
  });
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

function validateKnowledgeNodeInput(node) {
  validateNodeId(node?.id);
  validateNodeType(node?.type);
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

function dedupeValues(values): string[] {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

async function readJson(filePath, fallbackValue) {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error: any) {
    if (error instanceof SyntaxError) {
      // 状态文件损坏（可能是磁盘满、外部编辑、上次崩溃）。退到 fallback 并提示，避免后续操作永久挂死。
      console.warn(`[notra] 状态文件 ${filePath} 解析失败，已回退到默认值：${error.message}`);
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
