#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
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
    await runAgentInit(flags);
    return;
  }

  if (command === "project-init" || command === "init-project") {
    await printJson(await initializeProjectKnowledge(resolveTarget(positionals[0])));
    return;
  }

  if (command === "preflight") {
    const [targetPath, ...taskParts] = positionals;
    await printJson(await runPreflight(resolveTarget(targetPath), taskParts.join(" ")));
    return;
  }

  if (command === "status") {
    await printJson(await generateStatusReport(resolveTarget(positionals[0])));
    return;
  }

  if (command === "graph") {
    await printGraphResult(await buildProjectGraphArtifacts(resolveKnowledgeRoot(positionals[0])));
    return;
  }

  if (command === "crystallize") {
    const projectRoot = resolveTarget(positionals[0]);
    const input = await loadCrystallizeCliInput(projectRoot, positionals.slice(1));
    await printJson(await crystallizeSession(projectRoot, input));
    return;
  }

  if (command === "auto-crystallize") {
    const projectRoot = resolveTarget(positionals[0]);
    const input = await loadAutoCrystallizeCliInput(projectRoot, positionals.slice(1));
    await printJson(await autoCrystallizeSession(projectRoot, input));
    return;
  }

  if (command === "lint") {
    await printJson(await lintProjectKnowledge(resolveTarget(positionals[0])));
    return;
  }

  if (command === "govern") {
    await printJson(await governProjectKnowledge(resolveTarget(positionals[0])));
    return;
  }

  if (command === "serve") {
    runServe(positionals);
    return;
  }

  throw new Error(`未知命令: ${command || ""}`.trim());
}

async function runAgentInit(flags) {
  const platforms = collectPlatforms(flags);
  const result = await installNotraPlatforms({
    projectRoot: flags.projectRoot || process.cwd(),
    packageRoot,
    platforms,
    dryRun: Boolean(flags.dryRun),
    force: Boolean(flags.force),
    skipExisting: Boolean(flags.skipExisting)
  });

  printInstallSummary(result);
}

function runServe(positionals) {
  const projectRoot = resolveTarget(positionals[0]);
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

    throw new Error(`未知参数: ${arg}`);
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

function resolveTarget(targetPath) {
  return path.resolve(targetPath || process.cwd());
}

function resolveKnowledgeRoot(targetPath) {
  const target = resolveTarget(targetPath);
  return path.basename(target) === ".notra" ? target : path.join(target, ".notra");
}

async function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

async function printGraphResult(result) {
  await printJson({
    generated_at: result.graph.generated_at,
    knowledge_root: result.graph.knowledge_root,
    output: {
      data: "graph/graph-data.json",
      index: "graph/graph-index.json",
      html: "graph/knowledge-graph.html"
    },
    counts_by_type: result.graph.stats.counts_by_type
  });
}

function printInstallSummary(result) {
  console.log(`已初始化 notra 平台配置: ${result.platforms.join(", ")}`);
  console.log(`项目目录: ${result.projectRoot}`);
  console.log(`写入文件: ${result.writes.length}`);
  if (result.skipped.length > 0) {
    console.log(`跳过文件: ${result.skipped.length}`);
  }
  if (result.dryRun) {
    console.log("dry-run 模式未写入文件。");
  }
}

function printHelp() {
  console.log(`notra CLI

用法:
  notra init [--claude] [--codex] [--agents] [--all]
  notra project-init [project-root]
  notra preflight [project-root] "任务描述"
  notra status [project-root]
  notra graph [project-root|knowledge-root]
  notra crystallize [project-root] [input.json|--input input.json]
  notra auto-crystallize [project-root] [input.json|--input input.json]
  notra lint [project-root]
  notra govern [project-root]
  notra serve [project-root] [port]

选项:
  --project-root, -C <path>  指定 Agent 配置初始化目标项目目录
  --dry-run                 只预览写入内容
  --force                   覆盖冲突文件
  --skip-existing           跳过冲突文件
  --version, -v             输出版本号
  --help, -h                输出帮助`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
