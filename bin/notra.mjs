#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { autoCrystallizeSession, loadAutoCrystallizeCliInput } from "../scripts/auto-crystallize-session.mjs";
import { buildProjectGraphArtifacts } from "../scripts/build-project-graph-data.mjs";
import { crystallizeSession, loadCrystallizeCliInput } from "../scripts/crystallize-session.mjs";
import { governProjectKnowledge } from "../scripts/govern-project-knowledge.mjs";
import { initializeProjectKnowledge } from "../scripts/init-project-knowledge.mjs";
import { lintProjectKnowledge } from "../scripts/lint-project-knowledge.mjs";
import {
  getSupportedPlatforms,
  installNotraPlatforms
} from "../scripts/platform-installers.mjs";
import { runPreflight } from "../scripts/preflight-session.mjs";
import { createProjectKnowledgeServer } from "../scripts/serve-project-knowledge.mjs";
import { generateStatusReport } from "../scripts/status-report.mjs";

const currentFilePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(currentFilePath), "..");

async function main(argv = process.argv.slice(2)) {
  const { command, flags, positionals } = parseArgs(argv);

  if (flags.help || command === "help") {
    printHelp();
    return;
  }

  if (flags.version || command === "--version") {
    console.log(await readPackageVersion());
    return;
  }

  if (command === "init") {
    await runInit(flags);
    return;
  }

  if (command === "project-init" || command === "init-project") {
    const result = await initializeProjectKnowledge(resolveTarget(positionals[0], flags), pickWriteOptions(flags));
    await printResult(result, { json: flags.json, formatter: formatProjectInitSummary });
    return;
  }

  if (command === "start") {
    const { projectRoot, taskText } = await resolveTaskCommand(positionals, flags);
    const result = await runPreflight(projectRoot, taskText);
    await printResult(result, { json: flags.json, formatter: formatStartSummary });
    return;
  }

  if (command === "preflight") {
    const [targetPath, ...taskParts] = positionals;
    const result = await runPreflight(resolveTarget(targetPath, flags), taskParts.join(" "));
    await printResult(result, { json: flags.json, formatter: formatStartSummary });
    return;
  }

  if (command === "finish") {
    const result = await runFinish(positionals, flags);
    await printResult(result, { json: flags.json, formatter: formatFinishSummary });
    return;
  }

  if (command === "status") {
    const report = await generateStatusReport(resolveTarget(positionals[0], flags));
    await printResult(report, { json: flags.json, formatter: formatStatusSummary });
    return;
  }

  if (command === "doctor") {
    const result = await runDoctor(resolveTarget(positionals[0], flags));
    await printResult(result, { json: flags.json, formatter: formatDoctorSummary });
    if (flags.strict && result.summary.fail > 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "graph") {
    const result = await buildProjectGraphArtifacts(resolveKnowledgeRoot(positionals[0], flags));
    await printResult(formatGraphJson(result), { json: flags.json, formatter: formatGraphSummary });
    return;
  }

  if (command === "crystallize") {
    const projectRoot = resolveTarget(positionals[0], flags);
    const input = await loadCrystallizeCliInput(projectRoot, buildInputArgs(flags, positionals.slice(1)));
    await printResult(await crystallizeSession(projectRoot, input), {
      json: flags.json,
      formatter: formatCrystallizeSummary
    });
    return;
  }

  if (command === "auto-crystallize") {
    const projectRoot = resolveTarget(positionals[0], flags);
    const input = await loadAutoCrystallizeCliInput(projectRoot, buildInputArgs(flags, positionals.slice(1)));
    await printResult(await autoCrystallizeSession(projectRoot, input), {
      json: flags.json,
      formatter: formatCrystallizeSummary
    });
    return;
  }

  if (command === "lint") {
    const report = await lintProjectKnowledge(resolveTarget(positionals[0], flags));
    await printResult(report, { json: flags.json, formatter: formatLintSummary });
    return;
  }

  if (command === "govern") {
    if (!flags.yes && shouldUseInteractive(flags)) {
      const confirmed = await promptConfirm("notra govern 会移动或标记知识节点，是否继续？", false);
      if (!confirmed) {
        console.log("已取消知识治理。");
        return;
      }
    }
    await printResult(await governProjectKnowledge(resolveTarget(positionals[0], flags)), {
      json: flags.json,
      formatter: formatGovernSummary
    });
    return;
  }

  if (command === "serve") {
    runServe(positionals, flags);
    return;
  }

  throw new CliError(`未知命令: ${command || ""}`.trim(), 2);
}

async function runInit(flags) {
  const interactive = shouldUseInteractive(flags);
  const projectRoot = path.resolve(flags.projectRoot || process.cwd());
  const selectedPlatforms = await resolveInitPlatforms(flags, interactive);
  const initializeKnowledge = flags.platformOnly ? false : await resolveInitProjectKnowledge(flags, interactive);
  const result = {
    ok: true,
    projectRoot,
    platformInstall: null,
    projectKnowledge: null,
    nextSteps: []
  };

  if (!flags.projectOnly) {
    result.platformInstall = await runWriteOperationWithConflictPrompt(
      (writeOptions) => installNotraPlatforms({
        projectRoot,
        packageRoot,
        platforms: selectedPlatforms,
        ...writeOptions
      }),
      flags,
      interactive
    );
  }

  if (initializeKnowledge) {
    result.projectKnowledge = await runWriteOperationWithConflictPrompt(
      (writeOptions) => initializeProjectKnowledge(projectRoot, writeOptions),
      flags,
      interactive
    );
  }

  if (!result.projectKnowledge?.alreadyInitialized) {
    result.nextSteps.push('notra start "描述你的任务"');
  }
  result.nextSteps.push("notra status", "notra doctor");

  await printResult(result, { json: flags.json, formatter: formatInitSummary });
}

async function resolveInitPlatforms(flags, interactive) {
  const platforms = collectPlatforms(flags);
  if (!interactive || flags.yes || platforms.length > 0 || flags.projectOnly) {
    return platforms;
  }

  const answer = await promptText(
    "请选择要安装的平台 [agents/claude/codex/all]，默认 agents：",
    "agents"
  );
  return answer === "all" ? ["all"] : answer.split(",").map((item) => item.trim()).filter(Boolean);
}

async function resolveInitProjectKnowledge(flags, interactive) {
  if (flags.projectOnly || flags.yes || !interactive) {
    return true;
  }

  return await promptConfirm("是否初始化当前项目的 .notra 知识库？", true);
}

async function runWriteOperationWithConflictPrompt(operation, flags, interactive) {
  try {
    return await operation(pickWriteOptions(flags));
  } catch (error) {
    if (!interactive || !String(error.message || "").includes("目标文件已存在且内容不同")) {
      throw error;
    }

    const action = await promptText("检测到已有文件内容不同，选择处理方式 [skip/force/abort]：", "abort");
    if (action === "skip") {
      return await operation({ ...pickWriteOptions(flags), skipExisting: true });
    }
    if (action === "force") {
      return await operation({ ...pickWriteOptions(flags), force: true });
    }
    throw new CliError("已取消初始化。", 1);
  }
}

async function runFinish(positionals, flags) {
  const { projectRoot, taskText, rest } = await resolveFinishCommand(positionals, flags);
  const inputArgs = buildInputArgs(flags, rest.length > 0 ? rest : taskText ? [taskText] : []);
  const input = await loadAutoCrystallizeCliInput(projectRoot, inputArgs);
  const crystallize = await autoCrystallizeSession(projectRoot, input);
  let lint = null;
  let status = null;

  if (crystallize.mode !== "no-knowledge") {
    lint = await lintProjectKnowledge(projectRoot);
    status = await generateStatusReport(projectRoot);
  }

  return {
    ok: true,
    projectRoot,
    knowledgeRoot: crystallize.knowledgeRoot,
    crystallize,
    lint,
    status,
    nextSteps: buildFinishNextSteps(crystallize, lint, status)
  };
}

async function runDoctor(projectRoot) {
  const knowledgeRoot = path.join(projectRoot, ".notra");
  const checks = [];

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

async function addPathCheck(checks, id, targetPath, successMessage, missingStatus = "fail") {
  checks.push({
    id,
    status: await exists(targetPath) ? "pass" : missingStatus,
    message: await exists(targetPath) ? successMessage : `未找到: ${targetPath}`,
    path: targetPath
  });
}

async function addSkillCheck(checks, projectRoot, platform, segments) {
  const skillRoot = path.join(projectRoot, ...segments);
  const hasSkill = await exists(path.join(skillRoot, "notra-init", "SKILL.md"));
  checks.push({
    id: `${platform}-skill`,
    status: hasSkill ? "pass" : "warn",
    message: hasSkill ? `${platform} skill 已安装` : `${platform} skill 未安装`,
    path: skillRoot
  });
}

async function addStatusCheck(checks, projectRoot) {
  try {
    const status = await generateStatusReport(projectRoot);
    checks.push({
      id: "status",
      status: "pass",
      message: `状态可读取，稳定节点 ${status.stableNodes}，孵化节点 ${status.incubatingNodes}`,
      details: status
    });
  } catch (error) {
    checks.push({ id: "status", status: "fail", message: error.message });
  }
}

async function addLintCheck(checks, projectRoot) {
  try {
    const lint = await lintProjectKnowledge(projectRoot);
    checks.push({
      id: "lint",
      status: lint.summary.issue_count > 0 ? "warn" : "pass",
      message: `lint issue 数量: ${lint.summary.issue_count}`,
      details: lint.summary
    });
  } catch (error) {
    checks.push({ id: "lint", status: "fail", message: error.message });
  }
}

async function addRuntimeStateCheck(checks, knowledgeRoot) {
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
    checks.push({ id: "runtime-state", status: "fail", message: error.message, path: statePath });
  }
}

function summarizeChecks(checks) {
  return checks.reduce(
    (summary, check) => ({
      ...summary,
      [check.status]: (summary[check.status] || 0) + 1
    }),
    { pass: 0, warn: 0, fail: 0 }
  );
}

function buildDoctorSuggestions(checks) {
  const suggestions = [];
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

function runServe(positionals, flags) {
  const projectRoot = resolveTarget(positionals[0], flags);
  const port = Number(positionals[1] || process.env.PORT || 8124);
  const server = createProjectKnowledgeServer(projectRoot);
  server.listen(port, "127.0.0.1", () => {
    console.log(`Project knowledge preview: http://127.0.0.1:${port}/graph/knowledge-graph.html`);
  });
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  let command = "init";
  let commandSet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("-") && !commandSet) {
      command = arg;
      commandSet = true;
      continue;
    }

    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }

    if (arg === "--project-root" || arg === "-C") {
      flags.projectRoot = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--input" || arg === "-i") {
      flags.input = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--json") {
      flags.json = true;
      continue;
    }

    if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
      continue;
    }

    if (arg === "--no-interactive") {
      flags.noInteractive = true;
      continue;
    }

    if (arg === "--dry-run") {
      flags.dryRun = true;
      continue;
    }

    if (arg === "--force") {
      flags.force = true;
      continue;
    }

    if (arg === "--skip-existing") {
      flags.skipExisting = true;
      continue;
    }

    if (arg === "--platform-only") {
      flags.platformOnly = true;
      continue;
    }

    if (arg === "--project-only") {
      flags.projectOnly = true;
      continue;
    }

    if (arg === "--strict") {
      flags.strict = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      flags.version = true;
      continue;
    }

    const platform = arg.slice(2);
    if (arg.startsWith("--") && (getSupportedPlatforms().includes(platform) || platform === "all")) {
      flags[platform] = true;
      continue;
    }

    throw new CliError(`未知参数: ${arg}`, 2);
  }

  return { command, flags, positionals };
}

function collectPlatforms(flags) {
  if (flags.all) {
    return ["all"];
  }

  return getSupportedPlatforms().filter((platform) => flags[platform]);
}

async function readPackageVersion() {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(packageRoot, "package.json"), "utf8")
  );
  return packageJson.version;
}

function resolveTarget(targetPath, flags = {}) {
  return path.resolve(flags.projectRoot || targetPath || process.cwd());
}

function resolveKnowledgeRoot(targetPath, flags = {}) {
  const target = resolveTarget(targetPath, flags);
  return path.basename(target) === ".notra" ? target : path.join(target, ".notra");
}

async function resolveTaskCommand(positionals, flags) {
  if (flags.projectRoot) {
    return { projectRoot: resolveTarget(null, flags), taskText: positionals.join(" ") };
  }

  if (positionals.length > 1 && await exists(positionals[0])) {
    return { projectRoot: path.resolve(positionals[0]), taskText: positionals.slice(1).join(" ") };
  }

  return { projectRoot: process.cwd(), taskText: positionals.join(" ") };
}

async function resolveFinishCommand(positionals, flags) {
  if (flags.projectRoot) {
    return { projectRoot: resolveTarget(null, flags), taskText: positionals.join(" "), rest: positionals };
  }

  if (positionals.length > 1 && await exists(positionals[0])) {
    return {
      projectRoot: path.resolve(positionals[0]),
      taskText: positionals.slice(1).join(" "),
      rest: positionals.slice(1)
    };
  }

  return { projectRoot: process.cwd(), taskText: positionals.join(" "), rest: positionals };
}

function buildInputArgs(flags, args) {
  return flags.input ? ["--input", flags.input] : args;
}

function pickWriteOptions(flags) {
  return {
    dryRun: Boolean(flags.dryRun),
    force: Boolean(flags.force),
    skipExisting: Boolean(flags.skipExisting)
  };
}

async function printResult(payload, { json, formatter }) {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(formatter(payload));
}

function formatInitSummary(result) {
  const lines = ["Notra 初始化完成", "", `项目目录: ${result.projectRoot}`];
  if (result.platformInstall) {
    lines.push(
      `平台配置: ${result.platformInstall.platforms.join(", ") || "未安装"}`,
      `平台写入: ${result.platformInstall.writes.length}`,
      `平台跳过: ${result.platformInstall.skipped.length}`
    );
  }
  if (result.projectKnowledge) {
    lines.push(
      `知识库: ${result.projectKnowledge.knowledgeRoot}`,
      result.projectKnowledge.alreadyInitialized
        ? "知识库状态: 已存在，未覆盖"
        : `稳定节点: ${result.projectKnowledge.stableNodeIds.length}`,
      result.projectKnowledge.alreadyInitialized
        ? `跳过文件: ${result.projectKnowledge.skipped.length}`
        : `孵化节点: ${result.projectKnowledge.incubatingNodeIds.length}`
    );
  }
  if (result.platformInstall?.dryRun || result.projectKnowledge?.dryRun) {
    lines.push("dry-run 模式未写入文件。");
  }
  lines.push("", "下一步:", ...result.nextSteps.map((step) => `- ${step}`));
  return lines.join("\n");
}

function formatProjectInitSummary(result) {
  if (result.alreadyInitialized) {
    return [
      "项目知识库已存在，未覆盖。",
      `项目目录: ${result.projectRoot}`,
      `知识库: ${result.knowledgeRoot}`,
      "如需覆盖，请使用 --force；如需补齐缺失文件，请使用 --skip-existing。"
    ].join("\n");
  }

  return [
    "项目知识库初始化完成",
    `项目目录: ${result.projectRoot}`,
    `知识库: ${result.knowledgeRoot}`,
    `技术栈: ${result.tech.join(", ") || "待补充"}`,
    `稳定节点: ${result.stableNodeIds.length}`,
    `孵化节点: ${result.incubatingNodeIds.length}`,
    result.dryRun ? "dry-run 模式未写入文件。" : ""
  ].filter(Boolean).join("\n");
}

function formatStartSummary(result) {
  if (result.mode === "no-knowledge") {
    return [
      "当前项目尚未初始化 Notra 知识库。",
      `项目目录: ${result.projectRoot}`,
      "下一步: notra init"
    ].join("\n");
  }

  if (result.mode === "needs-project-scan") {
    return [
      "未命中已有知识，已返回项目扫描线索。",
      `知识库: ${result.knowledgeRoot}`,
      `Evidence hints: ${result.evidenceHintCount}`,
      "任务完成后建议运行: notra finish \"任务总结\""
    ].join("\n");
  }

  return [
    "命中已有项目知识",
    `知识库: ${result.knowledgeRoot}`,
    `匹配实践: ${result.matchedPractices.length}`,
    ...result.matchedPractices.map((item) => `- ${item.title} (${item.id})`),
    `推荐方案: ${result.recommendedOptions.length}`,
    ...result.recommendedOptions.map((item) => `- ${item.title} (${item.id}) score=${item.effective_score}`),
    `Evidence hints: ${result.evidenceHintCount}`,
    "任务完成后建议运行: notra finish \"任务总结\""
  ].join("\n");
}

function formatFinishSummary(result) {
  if (result.crystallize.mode === "no-knowledge") {
    return [
      "未沉淀知识：当前项目尚未初始化 Notra。",
      `项目目录: ${result.projectRoot}`,
      "下一步: notra init"
    ].join("\n");
  }

  return [
    "任务知识沉淀完成",
    `知识库: ${result.knowledgeRoot}`,
    `Session: ${result.crystallize.sessionId}`,
    `采纳节点: ${result.crystallize.adoptedNodeIds.length}`,
    `新增孵化节点: ${result.crystallize.incubatingNodeIds.length}`,
    `更新节点: ${result.crystallize.updatedNodeIds.length}`,
    `Lint issues: ${result.lint?.summary.issue_count ?? 0}`,
    `稳定节点: ${result.status?.stableNodes ?? 0}`,
    `孵化节点: ${result.status?.incubatingNodes ?? 0}`,
    "下一步:",
    ...result.nextSteps.map((step) => `- ${step}`)
  ].join("\n");
}

function buildFinishNextSteps(crystallize, lint, status) {
  if (crystallize.mode === "no-knowledge") {
    return ["notra init"];
  }

  const steps = [];
  if ((lint?.summary.issue_count || 0) > 0) {
    steps.push("notra lint");
  }
  if (status?.graphDirty) {
    steps.push("notra graph");
  }
  steps.push("notra status");
  return [...new Set(steps)];
}

function formatStatusSummary(report) {
  return [
    "Notra 状态",
    "",
    `项目: ${report.projectTitle}`,
    `知识库: ${report.knowledgeRoot}`,
    `稳定节点: ${report.stableNodes}`,
    `孵化节点: ${report.incubatingNodes}`,
    `Graph dirty: ${report.graphDirty ? "yes" : "no"}`,
    `最近图谱构建: ${report.lastGraphBuildAt || "无"}`,
    "最近 session:",
    ...(report.recentSessions.length > 0
      ? report.recentSessions.map((item) => `- ${item.title} (${item.id})`)
      : ["- 无"]),
    "推荐方案:",
    ...(report.recommendedOptions.length > 0
      ? report.recommendedOptions.map((item) => `- ${item}`)
      : ["- 无"])
  ].join("\n");
}

function formatDoctorSummary(result) {
  return [
    "Notra doctor",
    "",
    `项目目录: ${result.projectRoot}`,
    `知识库: ${result.knowledgeRoot}`,
    `通过: ${result.summary.pass}  警告: ${result.summary.warn}  失败: ${result.summary.fail}`,
    "检查项:",
    ...result.checks.map((check) => `- [${check.status}] ${check.id}: ${check.message}`),
    "建议:",
    ...(result.suggestions.length > 0 ? result.suggestions.map((item) => `- ${item}`) : ["- 无"])
  ].join("\n");
}

function formatLintSummary(report) {
  return [
    "Notra lint",
    "",
    `知识库: ${report.knowledgeRoot}`,
    `节点数: ${report.summary.total_nodes}`,
    `边数: ${report.summary.total_edges}`,
    `Issues: ${report.summary.issue_count}`,
    ...report.issues.slice(0, 10).map((issue) => `- [${issue.severity}] ${issue.code}: ${issue.message}`),
    report.issues.length > 10 ? `... 还有 ${report.issues.length - 10} 条` : ""
  ].filter(Boolean).join("\n");
}

function formatGraphJson(result) {
  return {
    generated_at: result.graph.generated_at,
    knowledge_root: result.graph.knowledge_root,
    output: {
      data: "graph/graph-data.json",
      index: "graph/graph-index.json",
      html: "graph/knowledge-graph.html"
    },
    counts_by_type: result.graph.stats.counts_by_type
  };
}

function formatGraphSummary(result) {
  return [
    "图谱已生成",
    "",
    `Data: ${result.output.data}`,
    `Index: ${result.output.index}`,
    `HTML: ${result.output.html}`,
    `节点类型: ${Object.entries(result.counts_by_type).map(([type, count]) => `${type}=${count}`).join(", ")}`
  ].join("\n");
}

function formatCrystallizeSummary(result) {
  return [
    "知识结晶完成",
    `模式: ${result.mode}`,
    `知识库: ${result.knowledgeRoot}`,
    `Session: ${result.sessionId || "无"}`,
    `采纳节点: ${result.adoptedNodeIds.length}`,
    `孵化节点: ${result.incubatingNodeIds.length}`,
    `更新节点: ${result.updatedNodeIds.length}`
  ].join("\n");
}

function formatGovernSummary(result) {
  return [
    "知识治理完成",
    `模式: ${result.mode}`,
    `知识库: ${result.knowledgeRoot}`,
    `动作数: ${result.action_count}`,
    `Graph rebuilt: ${result.graph_rebuilt ? "yes" : "no"}`,
    ...result.actions.map((action) => `- ${action.type}: ${action.node_id}`)
  ].join("\n");
}

function shouldUseInteractive(flags) {
  return !flags.json && !flags.yes && !flags.noInteractive && Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptText(question, fallback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} `);
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

async function promptConfirm(question, fallback) {
  const answer = await promptText(`${question} ${fallback ? "[Y/n]" : "[y/N]"}`, fallback ? "y" : "n");
  return ["y", "yes", "是"].includes(answer.toLowerCase());
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function printHelp() {
  console.log(`notra CLI

Getting started:
  notra init                         一站式初始化 Notra
  notra start "任务描述"              开始任务前获取项目知识建议
  notra finish "任务总结"             完成任务后沉淀知识
  notra status                       查看知识库状态
  notra doctor                       诊断 Notra 配置和知识库健康度

Advanced:
  notra project-init [project-root]   仅初始化项目知识库
  notra preflight [project-root] ...  底层 preflight
  notra crystallize [project-root] [input.json|--input input.json]
  notra auto-crystallize [project-root] [input.json|--input input.json]
  notra lint [project-root]
  notra govern [project-root]
  notra graph [project-root|knowledge-root]
  notra serve [project-root] [port]

Options:
  --project-root, -C <path>  指定目标项目目录
  --json                    输出机器可读 JSON
  --yes, -y                 跳过确认，使用默认值
  --no-interactive          禁用交互式提示
  --dry-run                 只预览写入内容
  --force                   覆盖冲突文件
  --skip-existing           跳过冲突文件
  --platform-only           init 时只安装平台 skill/runtime
  --project-only            init 时只初始化 .notra 知识库
  --claude|--codex|--agents|--all  选择安装平台
  --strict                  doctor 存在失败项时返回非零退出码
  --version, -v             输出版本号
  --help, -h                输出帮助`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = error.exitCode || 1;
});
