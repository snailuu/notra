#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { normalizeEvidencePaths } from "../knowledge/evidence.js";
import { crystallizeSession } from "./crystallize.js";
import { runPreflight } from "./preflight.js";

const execFileAsync = promisify(execFile);
const GIT_STATUS_TIMEOUT_MS = 5000;
const GIT_STATUS_MAX_BUFFER_BYTES = 1024 * 1024;

export async function autoCrystallizeSession(projectRootOrKnowledgeRoot, input: Record<string, any> = {}) {
  const target = await resolveProjectTarget(projectRootOrKnowledgeRoot);
  if (!target.hasKnowledge) {
    return buildNoKnowledgeResult(target);
  }

  const taskText = buildTaskText(input);
  const touchedFileResult = await resolveTouchedFiles(target.projectRoot, input);
  const touchedFiles = touchedFileResult.files;
  reportTouchedFilesWarning(touchedFileResult.warning);
  const preflight = await runPreflight(target.projectRoot, taskText);
  const adoptedNodeIds = Array.isArray(input.adoptedNodeIds)
    ? dedupeValues(input.adoptedNodeIds)
    : inferAdoptedNodeIds(preflight);
  const incubatingNodes = Array.isArray(input.incubatingNodes)
    ? input.incubatingNodes
    : buildIncubatingNodes({
      input,
      taskText,
      touchedFiles,
      preflightMode: preflight.mode
    });

  const crystallizeInput = {
    ...input,
    title: input.title || "自动知识结晶",
    topic: input.topic || taskText || "auto-crystallize",
    taskText,
    decisionSummary: input.decisionSummary || taskText || "自动记录本轮任务知识沉淀。",
    touchedFiles,
    adoptedNodeIds,
    incubatingNodes,
    stableUpdates: input.stableUpdates || []
  };
  const result = await crystallizeSession(target.projectRoot, crystallizeInput);

  return {
    ...result,
    auto: {
      preflightMode: preflight.mode,
      touchedFiles,
      touchedFilesWarning: touchedFileResult.warning,
      inferredAdoptedNodeIds: adoptedNodeIds,
      generatedIncubatingNodeIds: incubatingNodes.map((node) => node.id)
    }
  };
}

export async function loadAutoCrystallizeCliInput(projectRootOrKnowledgeRoot, cliArgs = [], defaults = {}) {
  const args = [...cliArgs].filter((arg) => arg !== undefined && arg !== null);
  const defaultInput = {
    topic: "auto-crystallize",
    title: "自动知识结晶",
    decisionSummary: "自动执行了一次项目知识结晶。",
    ...defaults
  };

  if (args.length === 0) {
    return defaultInput;
  }

  if (args[0] === "--input" || args[0] === "-i") {
    if (!args[1]) {
      throw new Error("缺少自动结晶输入 JSON 文件路径");
    }
    return {
      ...defaultInput,
      ...(await readAutoCrystallizeInputFile(projectRootOrKnowledgeRoot, args[1]))
    };
  }

  const inputPath = await resolveExistingInputFile(projectRootOrKnowledgeRoot, args[0]);
  if (inputPath) {
    return {
      ...defaultInput,
      ...(await readJson(inputPath, {}))
    };
  }

  const taskText = args.join(" ");
  return {
    ...defaultInput,
    topic: taskText || defaultInput.topic,
    taskText,
    decisionSummary: taskText || defaultInput.decisionSummary
  };
}

async function resolveProjectTarget(projectRootOrKnowledgeRoot) {
  const resolved = path.resolve(projectRootOrKnowledgeRoot || process.cwd());

  if (await exists(path.join(resolved, "project-profile.md"))) {
    return {
      hasKnowledge: true,
      projectRoot: path.dirname(resolved),
      knowledgeRoot: resolved
    };
  }

  const knowledgeRoot = path.join(resolved, ".notra");
  if (await exists(path.join(knowledgeRoot, "project-profile.md"))) {
    return {
      hasKnowledge: true,
      projectRoot: resolved,
      knowledgeRoot
    };
  }

  return {
    hasKnowledge: false,
    projectRoot: resolved,
    knowledgeRoot
  };
}

function buildNoKnowledgeResult(target) {
  return {
    mode: "no-knowledge",
    skipped: true,
    reason: "project-knowledge-not-initialized",
    projectRoot: target.projectRoot,
    knowledgeRoot: target.knowledgeRoot,
    sessionId: null,
    incubatingNodeIds: [],
    updatedNodeIds: [],
    adoptedNodeIds: [],
    auto: {
      preflightMode: "no-knowledge",
      touchedFiles: [],
      touchedFilesWarning: null,
      inferredAdoptedNodeIds: [],
      generatedIncubatingNodeIds: []
    }
  };
}

function buildTaskText(input) {
  return [
    input.taskText,
    input.topic,
    input.title,
    input.decisionSummary
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function reportTouchedFilesWarning(warning: any) {
  if (!warning) {
    return;
  }
  const errors = Array.isArray(warning.fallback_errors) ? warning.fallback_errors : [];
  if (errors.length === 0) {
    console.warn(`[notra] git touched-files 采集不完整 (${warning.code || "unknown"})`);
    return;
  }
  console.warn(`[notra] git touched-files 采集不完整 (${warning.code || "unknown"})，fallback 命令也失败:`);
  for (const err of errors) {
    console.warn(`  - ${err.command}: ${err.message}`);
  }
}

async function resolveTouchedFiles(projectRoot, input) {
  if (Array.isArray(input.touchedFiles) && input.touchedFiles.length > 0) {
    return { files: normalizeTouchedFiles(input.touchedFiles), warning: null };
  }

  const result = await collectGitTouchedFiles(projectRoot);
  return {
    files: normalizeTouchedFiles(result.files),
    warning: result.warning
  };
}

async function collectGitTouchedFiles(projectRoot) {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      projectRoot,
      "status",
      "--porcelain",
      "-uall"
    ], {
      windowsHide: true,
      timeout: GIT_STATUS_TIMEOUT_MS,
      maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES
    });
    return {
      files: stdout
        .split(/\r?\n/)
        .map((line) => parseGitStatusPath(line))
        .filter(Boolean),
      warning: null
    };
  } catch (error) {
    const fallback = await collectFallbackGitTouchedFiles(projectRoot);
    return {
      files: fallback.files,
      warning: {
        ...buildGitStatusWarning(error),
        fallback: fallback.files.length > 0 ? "tracked-diff" : null,
        incomplete: true,
        fallback_errors: fallback.errors
      }
    };
  }
}

async function collectFallbackGitTouchedFiles(projectRoot) {
  const outputs = await Promise.all([
    collectGitFileList(projectRoot, ["diff", "--name-only", "--cached"]),
    collectGitFileList(projectRoot, ["diff", "--name-only"]),
    collectGitFileList(projectRoot, ["status", "--porcelain", "-uno"])
  ]);
  return {
    files: dedupeValues(outputs.flatMap((output) => output.files)),
    errors: outputs.flatMap((output) => output.errors)
  };
}

async function collectGitFileList(projectRoot, args): Promise<{ files: string[]; errors: Array<{ command: string; message: string }> }> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", projectRoot, ...args], {
      windowsHide: true,
      timeout: GIT_STATUS_TIMEOUT_MS,
      maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES
    });
    return {
      files: stdout
        .split(/\r?\n/)
        .map((line) => args[0] === "status" ? parseGitStatusPath(line) : line.trim())
        .filter(Boolean) as string[],
      errors: []
    };
  } catch (error) {
    return {
      files: [],
      errors: [{ command: `git ${args.join(" ")}`, message: String((error as Error)?.message || error) }]
    };
  }
}

function buildGitStatusWarning(error) {
  const message = String(error?.message || "git status failed");
  if (message.includes("maxBuffer")) {
    return { code: "git-status-max-buffer", message };
  }
  if (error?.killed || error?.signal === "SIGTERM") {
    return { code: "git-status-timeout", message };
  }
  return { code: "git-status-failed", message };
}

function parseGitStatusPath(line) {
  if (!line || line.length < 4) {
    return null;
  }

  const rawPath = line.slice(3).trim();
  const renameTarget = rawPath.includes(" -> ")
    ? rawPath.split(" -> ").at(-1)
    : rawPath;
  return unquoteGitPath(renameTarget);
}

function unquoteGitPath(filePath) {
  const value = String(filePath || "").trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeTouchedFiles(files) {
  return normalizeEvidencePaths(files);
}

function inferAdoptedNodeIds(preflight) {
  if (preflight.mode !== "knowledge-hit") {
    return [];
  }

  return dedupeValues(
    (preflight.matchedPractices || [])
      .map((practice) => practice.recommended_option)
      .filter(Boolean)
  );
}

function buildIncubatingNodes({ input, taskText, touchedFiles, preflightMode }) {
  if (preflightMode === "knowledge-hit" || touchedFiles.length === 0) {
    return [];
  }

  const metadata = buildIncubatingNodeMetadata({ input, taskText, touchedFiles });
  const keywords = dedupeValues([
    ...(metadata.keywords || []),
    ...extractKeywords(taskText || metadata.practiceTitle)
  ]);

  return [
    {
      id: metadata.practiceId,
      type: "practice",
      title: metadata.practiceTitle,
      summary: metadata.practiceSummary,
      contexts: [],
      constraints: [],
      rules: [],
      option_ids: [metadata.optionId],
      keywords,
      source_evidence: touchedFiles
    },
    {
      id: metadata.optionId,
      type: "option",
      title: metadata.optionTitle,
      summary: metadata.optionSummary,
      practice: metadata.practiceId,
      base_score: 36,
      score_breakdown: {
        consistency: 7,
        efficiency: 7,
        maintainability: 8,
        extensibility: 7,
        risk: 7
      },
      alternatives: [],
      keywords,
      source_evidence: touchedFiles
    }
  ];
}

function buildIncubatingNodeMetadata({ input, taskText, touchedFiles }) {
  const detectedPattern = detectLongRunningAutoTaskPattern({ input, taskText, touchedFiles });
  if (detectedPattern) {
    return detectedPattern;
  }

  const slug = slugify(input.taskText || input.topic || input.title || taskText || "session");
  const title = input.title || input.topic || taskText || "新场景";
  const summary = input.decisionSummary || `从本轮任务中发现 ${title} 的候选实践。`;

  return {
    practiceId: `practice-${slug}`,
    optionId: `option-${slug}-candidate`,
    practiceTitle: `${title} 实践`,
    optionTitle: `${title} 候选方案`,
    practiceSummary: summary,
    optionSummary: summary,
    keywords: extractKeywords(taskText || title)
  };
}

function detectLongRunningAutoTaskPattern({ input, taskText, touchedFiles }) {
  const combinedText = [
    input.title,
    input.topic,
    input.taskText,
    input.decisionSummary,
    taskText
  ].filter(Boolean).join(" ").toLowerCase();
  const normalizedFiles = (touchedFiles || []).map((filePath) => String(filePath || "").toLowerCase());
  const hasSchedulerSignal =
    /全局调度器|调度器|调度\s*core|scheduler|schedule/.test(combinedText) ||
    normalizedFiles.some((filePath) => /scheduler|schedule/.test(filePath));
  const hasAutoTaskSignal =
    /自动任务|自动同步|自动|sync|tracking|轮询|定时/.test(combinedText) ||
    normalizedFiles.some((filePath) => /sync|tracking|scheduler/.test(filePath));
  const hasLifecycleBoundarySignal =
    /页面生命周期|生命周期|页面.*绑定|登录后|登录态|用户信息|用户.*加载|全局初始化|lifecycle/.test(combinedText);

  if (!hasSchedulerSignal || !hasAutoTaskSignal || !hasLifecycleBoundarySignal) {
    return null;
  }

  return {
    practiceId: "practice-long-running-auto-task-global-scheduler",
    optionId: "option-login-ready-global-scheduler",
    practiceTitle: "长周期自动任务应使用登录态就绪后的全局调度器",
    optionTitle: "登录态就绪后初始化全局调度器",
    practiceSummary:
      "长周期自动任务不应绑定具体页面生命周期；应在登录态或用户信息就绪后初始化全局调度器，读取开关、上次执行时间等状态后按需执行。",
    optionSummary:
      "将调度 core 与页面接线分离，在登录态就绪后启动全局调度器，由调度器读取开关和上次执行时间并触发任务。",
    keywords: [
      "自动任务",
      "自动同步",
      "长周期任务",
      "全局调度器",
      "登录态",
      "用户信息就绪",
      "页面生命周期",
      "调度 core",
      "scheduler",
      "lifecycle",
      "sync"
    ]
  };
}

function slugify(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "session";
}

function extractKeywords(value) {
  return dedupeValues(
    String(value || "")
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
      .slice(0, 8)
  );
}

async function readAutoCrystallizeInputFile(projectRootOrKnowledgeRoot, inputFilePath) {
  const resolvedInputPath = await resolveExistingInputFile(projectRootOrKnowledgeRoot, inputFilePath);
  if (!resolvedInputPath) {
    throw new Error(`未找到自动结晶输入 JSON: ${inputFilePath}`);
  }

  const input = await readJson(resolvedInputPath, {});
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new Error(`自动结晶输入 JSON 必须是对象: ${resolvedInputPath}`);
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

function dedupeValues(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
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
  const input = await loadAutoCrystallizeCliInput(projectRoot, process.argv.slice(3));
  const result = await autoCrystallizeSession(projectRoot, input);
  console.log(JSON.stringify(result, null, 2));
}
