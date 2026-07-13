#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { isCancel, multiselect, select } from "@clack/prompts";

import { collectPlatforms, parseArgs, type CliFlags } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import {
  buildFinishNextSteps,
  formatCrystallizeSummary,
  formatDoctorSummary,
  formatFinishSummary,
  formatGovernSummary,
  formatGraphJson,
  formatGraphSummary,
  formatInitSummary,
  formatLintSummary,
  formatProjectInitSummary,
  formatStartSummary,
  formatStatusSummary,
  formatUpdateSummary
} from "../cli/formatters.js";
import { printHelp } from "../cli/help.js";
import { printResult } from "../cli/output.js";
import { buildProjectGraphArtifacts } from "../core/graph/build.js";
import { governProjectKnowledge } from "../core/governance/govern.js";
import { lintProjectKnowledge } from "../core/governance/lint.js";
import { runUpdate, type PackageManager } from "../core/maintenance/update.js";
import { installNotraPlatforms, type PlatformInput } from "../core/platform/install.js";
import { runDoctor } from "../core/project/doctor.js";
import { initializeProjectKnowledge } from "../core/project/init.js";
import { generateStatusReport } from "../core/project/status.js";
import { autoCrystallizeSession, loadAutoCrystallizeCliInput } from "../core/session/auto-crystallize.js";
import { crystallizeSession, loadCrystallizeCliInput } from "../core/session/crystallize.js";
import { runPreflight } from "../core/session/preflight.js";
import { createProjectKnowledgeServer } from "../server/project-knowledge.js";

const currentFilePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(currentFilePath), "..", "..");

interface WriteOptions {
  dryRun: boolean;
  force: boolean;
  skipExisting: boolean;
}

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
    const result = await runDoctor(resolveTarget(positionals[0], flags), packageRoot);
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

  if (command === "update" || command === "upgrade") {
    const result = await runUpdate({
      target: positionals[0] || "latest",
      dryRun: Boolean(flags.dryRun),
      packageManager: resolvePackageManagerFlag(flags.packageManager),
      packageRoot
    });
    await printResult(result, { json: flags.json, formatter: formatUpdateSummary });
    if (result.mode === "manual-fallback") {
      process.exitCode = 1;
    }
    return;
  }

  throw new CliError(`未知命令: ${command || ""}`.trim(), 2);
}

function resolvePackageManagerFlag(value: string | undefined): PackageManager | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (normalized === "pnpm" || normalized === "npm" || normalized === "yarn" || normalized === "bun") {
    return normalized;
  }
  throw new CliError(`不支持的 --pm: ${value}（pnpm/npm/yarn/bun）`, 2);
}

async function runInit(flags: CliFlags) {
  const interactive = shouldUseInteractive(flags);
  const projectRoot = path.resolve(flags.projectRoot || process.cwd());
  const selectedPlatforms = await resolveInitPlatforms(flags, interactive);
  const initializeKnowledge = flags.platformOnly ? false : await resolveInitProjectKnowledge(flags, interactive);
  const result: {
    ok: true;
    projectRoot: string;
    platformInstall: Awaited<ReturnType<typeof installNotraPlatforms>> | null;
    projectKnowledge: Awaited<ReturnType<typeof initializeProjectKnowledge>> | null;
    nextSteps: string[];
  } = {
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

async function resolveInitPlatforms(flags: CliFlags, interactive: boolean): Promise<PlatformInput[]> {
  const platforms = collectPlatforms(flags);
  if (!interactive || flags.yes || platforms.length > 0 || flags.projectOnly) {
    return platforms;
  }

  const selected = await multiselect<PlatformInput>({
    message: "请选择要安装的平台（空格多选，回车确认）",
    options: [
      { value: "agents", label: "agents", hint: "默认" },
      { value: "claude", label: "claude" },
      { value: "codex", label: "codex" }
    ],
    initialValues: ["agents"],
    required: true
  });
  if (isCancel(selected)) {
    throw new CliError("已取消初始化。", 1);
  }
  return selected;
}

async function resolveInitProjectKnowledge(flags: CliFlags, interactive: boolean) {
  if (flags.projectOnly || flags.yes || !interactive) {
    return true;
  }

  return await promptConfirm("是否初始化当前项目的 .notra 知识库？", true);
}

async function runWriteOperationWithConflictPrompt<T>(
  operation: (writeOptions: WriteOptions) => Promise<T>,
  flags: CliFlags,
  interactive: boolean
): Promise<T> {
  try {
    return await operation(pickWriteOptions(flags));
  } catch (error) {
    if (!interactive || !String((error as Error)?.message || "").includes("目标文件已存在且内容不同")) {
      throw error;
    }

    const action = await select<"skip" | "force" | "abort">({
      message: "检测到已有文件内容不同，选择处理方式",
      options: [
        { value: "skip", label: "skip", hint: "跳过冲突文件，保留已有内容" },
        { value: "force", label: "force", hint: "覆盖已有文件" },
        { value: "abort", label: "abort", hint: "取消初始化" }
      ],
      initialValue: "abort"
    });
    if (action === "skip") {
      return await operation({ ...pickWriteOptions(flags), skipExisting: true });
    }
    if (action === "force") {
      return await operation({ ...pickWriteOptions(flags), force: true });
    }
    throw new CliError("已取消初始化。", 1);
  }
}

async function runFinish(positionals: string[], flags: CliFlags) {
  const { projectRoot, taskText, rest } = await resolveFinishCommand(positionals, flags);
  const inputArgs = buildInputArgs(flags, rest.length > 0 ? rest : taskText ? [taskText] : []);
  const input = await loadAutoCrystallizeCliInput(projectRoot, inputArgs);
  const crystallize = await autoCrystallizeSession(projectRoot, input);
  let lint: Awaited<ReturnType<typeof lintProjectKnowledge>> | null = null;
  let status: Awaited<ReturnType<typeof generateStatusReport>> | null = null;

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

function runServe(positionals: string[], flags: CliFlags) {
  const projectRoot = resolveTarget(positionals[0], flags);
  const port = Number(positionals[1] || process.env.PORT || 8124);
  const server = createProjectKnowledgeServer(projectRoot);
  server.listenLocal(port, () => {
    console.log(`Project knowledge preview: http://127.0.0.1:${port}/graph/knowledge-graph.html`);
  });
}

async function readPackageVersion() {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(packageRoot, "package.json"), "utf8")
  );
  return packageJson.version;
}

function resolveTarget(targetPath: string | undefined, flags: CliFlags = {}) {
  return path.resolve(flags.projectRoot || targetPath || process.cwd());
}

function resolveKnowledgeRoot(targetPath: string | undefined, flags: CliFlags = {}) {
  const target = resolveTarget(targetPath, flags);
  return path.basename(target) === ".notra" ? target : path.join(target, ".notra");
}

async function resolveTaskCommand(positionals: string[], flags: CliFlags) {
  if (flags.projectRoot) {
    return { projectRoot: resolveTarget(undefined, flags), taskText: positionals.join(" ") };
  }

  if (positionals.length > 1 && await exists(positionals[0])) {
    return { projectRoot: path.resolve(positionals[0]), taskText: positionals.slice(1).join(" ") };
  }

  return { projectRoot: process.cwd(), taskText: positionals.join(" ") };
}

async function resolveFinishCommand(positionals: string[], flags: CliFlags) {
  if (flags.projectRoot) {
    return { projectRoot: resolveTarget(undefined, flags), taskText: positionals.join(" "), rest: positionals };
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

function buildInputArgs(flags: CliFlags, args: string[]): string[] {
  return flags.input ? ["--input", flags.input] : args;
}

function pickWriteOptions(flags: CliFlags): WriteOptions {
  return {
    dryRun: Boolean(flags.dryRun),
    force: Boolean(flags.force),
    skipExisting: Boolean(flags.skipExisting)
  };
}

function shouldUseInteractive(flags: CliFlags): boolean {
  return !flags.json && !flags.yes && !flags.noInteractive && Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptText(question: string, fallback: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} `);
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

async function promptConfirm(question: string, fallback: boolean): Promise<boolean> {
  const answer = await promptText(`${question} ${fallback ? "[Y/n]" : "[y/N]"}`, fallback ? "y" : "n");
  return ["y", "yes", "是"].includes(answer.toLowerCase());
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
    return;
  }
  console.error(error);
  process.exitCode = (error as { exitCode?: number })?.exitCode || 1;
});
