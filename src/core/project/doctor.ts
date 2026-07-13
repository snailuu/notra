import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lintProjectKnowledge } from "../governance/lint.js";
import { isUserEdited, readRuntimeManifest, resolveRuntimeTrees } from "../platform/install.js";
import { generateStatusReport } from "./status.js";

const defaultPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** 陈旧文件可能多达上百个，details 里只列前几条，其余靠 staleCount + truncated 表达。 */
const MAX_REPORTED_STALE_FILES = 10;

/** stale: notra 自己的旧副本，init 能刷新。modified: 用户改过，init 会保留。 */
interface RuntimeDrift {
  stale: string[];
  modified: string[];
}

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  path?: string;
  details?: unknown;
}

export interface DoctorReport {
  ok: boolean;
  projectRoot: string;
  knowledgeRoot: string;
  checks: DoctorCheck[];
  summary: Record<DoctorCheckStatus, number>;
  suggestions: string[];
}

export async function runDoctor(projectRoot: string, packageRoot: string = defaultPackageRoot): Promise<DoctorReport> {
  const knowledgeRoot = path.join(projectRoot, ".notra");
  const checks: DoctorCheck[] = [];

  await addPathCheck(checks, "project-root", projectRoot, "项目目录存在");
  await addPathCheck(checks, "knowledge-profile", path.join(knowledgeRoot, "project-profile.md"), "项目知识库已初始化");
  await addPathCheck(checks, "sessions", path.join(knowledgeRoot, "sessions"), "sessions 目录存在");
  await addPathCheck(checks, "state", path.join(knowledgeRoot, "state"), "state 目录存在");
  await addPathCheck(checks, "graph", path.join(knowledgeRoot, "graph"), "graph 目录存在");
  await addPathCheck(checks, "plugin-scripts", path.join(knowledgeRoot, "plugin", "scripts"), "plugin scripts 存在", "warn");
  await addPathCheck(checks, "plugin-assets", path.join(knowledgeRoot, "plugin", "assets"), "plugin assets 存在", "warn");
  await addPathCheck(checks, "plugin-templates", path.join(knowledgeRoot, "plugin", "templates"), "plugin templates 存在", "warn");
  await addRuntimeFreshnessCheck(checks, projectRoot, knowledgeRoot, packageRoot);
  await addSkillCheck(checks, projectRoot, "claude", [".claude", "skills"]);
  await addSkillCheck(checks, projectRoot, "codex", [".codex", "skills"]);
  await addSkillCheck(checks, projectRoot, "agents", [".agents", "skills"]);
  await addStatusCheck(checks, projectRoot);
  await addLintCheck(checks, projectRoot);
  await addRuntimeStateCheck(checks, knowledgeRoot);
  await addPathCheck(checks, "graph-data", path.join(knowledgeRoot, "graph", "graph-data.json"), "graph-data.json 存在", "warn");
  await addPathCheck(checks, "graph-html", path.join(knowledgeRoot, "graph", "knowledge-graph.html"), "knowledge-graph.html 存在", "warn");

  const summary = summarizeChecks(checks);
  return {
    ok: summary.fail === 0,
    projectRoot,
    knowledgeRoot,
    checks,
    summary,
    suggestions: buildDoctorSuggestions(checks)
  };
}

async function addPathCheck(
  checks: DoctorCheck[],
  id: string,
  targetPath: string,
  successMessage: string,
  missingStatus: DoctorCheckStatus = "fail"
) {
  const found = await exists(targetPath);
  checks.push({
    id,
    status: found ? "pass" : missingStatus,
    message: found ? successMessage : `未找到: ${targetPath}`,
    path: targetPath
  });
}

/**
 * notra 升级后 .notra/plugin 里的运行时副本不会自动更新，逐文件比对才能发现陈旧。
 * 必须覆盖 dist/：plugins/notra/scripts 下是自动生成的薄壳（export * from dist/...），
 * 升级时常常逐字节不变，只比对 scripts 会在最常见的升级场景下漏报。
 */
async function addRuntimeFreshnessCheck(
  checks: DoctorCheck[],
  projectRoot: string,
  knowledgeRoot: string,
  packageRoot: string
) {
  const runtimeRoot = path.join(knowledgeRoot, "plugin");
  if (!(await exists(runtimeRoot))) {
    return;
  }

  try {
    // 复用 install 的 provenance 判定：陈旧（init 能刷新）与本地修改（init 会保留）必须分开报，
    // 否则会建议一条对本地修改毫无作用的命令，doctor 的 warn 永远消不掉。
    const manifest = await readRuntimeManifest(runtimeRoot);
    const drift: RuntimeDrift = { stale: [], modified: [] };
    for (const { source, target } of resolveRuntimeTrees(packageRoot, runtimeRoot)) {
      if (!(await exists(source))) {
        throw new Error(`notra 安装不完整，缺少源目录: ${source}`);
      }
      await collectRuntimeDrift({ sourceRoot: source, targetRoot: target, projectRoot, runtimeRoot, manifest, drift });
    }

    checks.push({
      id: "runtime-freshness",
      status: drift.stale.length + drift.modified.length > 0 ? "warn" : "pass",
      message: describeRuntimeDrift(drift),
      path: runtimeRoot,
      details: drift.stale.length + drift.modified.length > 0
        ? {
            staleCount: drift.stale.length,
            staleFiles: drift.stale.slice(0, MAX_REPORTED_STALE_FILES),
            modifiedCount: drift.modified.length,
            modifiedFiles: drift.modified.slice(0, MAX_REPORTED_STALE_FILES),
            truncated:
              drift.stale.length > MAX_REPORTED_STALE_FILES || drift.modified.length > MAX_REPORTED_STALE_FILES
          }
        : undefined
    });
  } catch (error) {
    // 与 status/lint 检查一致：单项检查失败不该让整个 doctor 崩溃
    checks.push({
      id: "runtime-freshness",
      status: "fail",
      message: (error as Error)?.message || String(error),
      path: runtimeRoot
    });
  }
}

function describeRuntimeDrift(drift: RuntimeDrift): string {
  const parts: string[] = [];
  if (drift.stale.length > 0) {
    parts.push(`${drift.stale.length} 个文件已过期`);
  }
  if (drift.modified.length > 0) {
    parts.push(`${drift.modified.length} 个文件有本地修改（init 会保留，加 --force 才还原）`);
  }
  return parts.length > 0 ? `运行时: ${parts.join("，")}` : "运行时与当前 notra 版本一致";
}

async function collectRuntimeDrift(options: {
  sourceRoot: string;
  targetRoot: string;
  projectRoot: string;
  runtimeRoot: string;
  manifest: Record<string, string> | null;
  drift: RuntimeDrift;
}) {
  const { sourceRoot, targetRoot, projectRoot, runtimeRoot, manifest, drift } = options;

  // 整个目录缺失只记一条，否则同一次「dist 没装」会按子树规模报出几十上百条
  if (!(await exists(targetRoot))) {
    drift.stale.push(`${path.relative(runtimeRoot, targetRoot)}/`);
    return;
  }

  for (const entry of await fs.readdir(sourceRoot, { withFileTypes: true })) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);

    if (entry.isDirectory()) {
      await collectRuntimeDrift({ ...options, sourceRoot: sourcePath, targetRoot: targetPath });
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const existing = await readTextOrNull(targetPath);
    if (existing === (await fs.readFile(sourcePath, "utf8"))) {
      continue;
    }

    const reportedPath = path.relative(runtimeRoot, targetPath);
    const userEdited =
      existing !== null && isUserEdited(existing, path.relative(projectRoot, targetPath), manifest, "runtime");
    (userEdited ? drift.modified : drift.stale).push(reportedPath);
  }
}

/** 只把「文件不存在」当作可比对的信号；其余 IO 错误必须暴露，否则会被误判成陈旧。 */
async function readTextOrNull(filePath: string): Promise<string | null> {
  return await fs.readFile(filePath, "utf8").catch((error: any) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
}

async function addSkillCheck(checks: DoctorCheck[], projectRoot: string, platform: string, segments: string[]) {
  const skillRoot = path.join(projectRoot, ...segments);
  const hasSkill = await exists(path.join(skillRoot, "notra-init", "SKILL.md"));
  checks.push({
    id: `${platform}-skill`,
    status: hasSkill ? "pass" : "warn",
    message: hasSkill ? `${platform} skill 已安装` : `${platform} skill 未安装`,
    path: skillRoot
  });
}

async function addStatusCheck(checks: DoctorCheck[], projectRoot: string) {
  try {
    const status = await generateStatusReport(projectRoot);
    checks.push({
      id: "status",
      status: "pass",
      message: `状态可读取，稳定节点 ${status.stableNodes}，孵化节点 ${status.incubatingNodes}`,
      details: status
    });
  } catch (error) {
    checks.push({ id: "status", status: "fail", message: (error as Error)?.message || String(error) });
  }
}

async function addLintCheck(checks: DoctorCheck[], projectRoot: string) {
  try {
    const lint = await lintProjectKnowledge(projectRoot);
    checks.push({
      id: "lint",
      status: lint.summary.issue_count > 0 ? "warn" : "pass",
      message: `lint issue 数量: ${lint.summary.issue_count}`,
      details: lint.summary
    });
  } catch (error) {
    checks.push({ id: "lint", status: "fail", message: (error as Error)?.message || String(error) });
  }
}

async function addRuntimeStateCheck(checks: DoctorCheck[], knowledgeRoot: string) {
  const statePath = path.join(knowledgeRoot, "state", "runtime-state.json");
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    checks.push({
      id: "runtime-state",
      status: state.graph_dirty ? "warn" : "pass",
      message: state.graph_dirty ? "图谱需要刷新" : "runtime state 正常",
      details: state
    });
  } catch (error) {
    checks.push({ id: "runtime-state", status: "fail", message: (error as Error)?.message || String(error), path: statePath });
  }
}

function summarizeChecks(checks: DoctorCheck[]): Record<DoctorCheckStatus, number> {
  return checks.reduce<Record<DoctorCheckStatus, number>>(
    (summary, check) => ({
      ...summary,
      [check.status]: (summary[check.status] || 0) + 1
    }),
    { pass: 0, warn: 0, fail: 0 }
  );
}

function buildDoctorSuggestions(checks: DoctorCheck[]): string[] {
  const suggestions: string[] = [];
  if (checks.some((check) => check.id === "knowledge-profile" && check.status === "fail")) {
    suggestions.push("notra init --yes");
  }
  if (checks.some((check) => check.id.startsWith("plugin-") && check.status !== "pass")) {
    suggestions.push("notra init --yes --platform-only");
  }
  // 只有陈旧文件才建议重装：对本地修改过的文件，重装会保留它们，建议了也没用
  const freshness = checks.find((check) => check.id === "runtime-freshness");
  const drift = freshness?.details as { staleCount?: number; modifiedCount?: number } | undefined;
  if ((drift?.staleCount ?? 0) > 0) {
    suggestions.push("notra init --yes --platform-only");
  }
  if ((drift?.modifiedCount ?? 0) > 0) {
    suggestions.push("notra init --yes --platform-only --force");
  }
  if (checks.some((check) => ["graph-data", "graph-html", "runtime-state"].includes(check.id) && check.status !== "pass")) {
    suggestions.push("notra graph");
  }
  if (checks.some((check) => check.id === "lint" && check.status === "warn")) {
    suggestions.push("notra lint");
  }
  return [...new Set(suggestions)];
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
