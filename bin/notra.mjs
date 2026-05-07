#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getSupportedPlatforms,
  installNotraPlatforms
} from "../scripts/platform-installers.mjs";

const currentFilePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(currentFilePath), "..");

async function main(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgs(argv);

  if (flags.help || command === "help") {
    printHelp();
    return;
  }

  if (flags.version || command === "--version") {
    console.log(await readPackageVersion());
    return;
  }

  if (command !== "init") {
    throw new Error(`未知命令: ${command || ""}`.trim());
  }

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

function parseArgs(argv) {
  const flags = {};
  let command = "init";
  let commandSet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("-") && !commandSet) {
      command = arg;
      commandSet = true;
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

  return { command, flags };
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

选项:
  --project-root, -C <path>  指定目标项目目录
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
