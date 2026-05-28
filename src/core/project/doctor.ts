import fs from "node:fs/promises";
import path from "node:path";

import { lintProjectKnowledge } from "../governance/lint.js";
import { generateStatusReport } from "./status.js";

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

export async function runDoctor(projectRoot: string): Promise<DoctorReport> {
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
    suggestions.push("notra init");
  }
  if (checks.some((check) => check.id.startsWith("plugin-") && check.status !== "pass")) {
    suggestions.push("notra init --platform-only");
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
