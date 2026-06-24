#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(packageRoot, "dist");
const pluginRoot = path.join(packageRoot, "plugins", "notra");
const pluginScriptsDir = path.join(pluginRoot, "scripts");

// 映射: dist 内的 js 文件 -> plugin/scripts 的 mjs 文件名
const wrapperMap = [
  { dist: "core/session/crystallize.js", name: "crystallize-session.mjs" },
  { dist: "core/session/auto-crystallize.js", name: "auto-crystallize-session.mjs" },
  { dist: "core/session/preflight.js", name: "preflight-session.mjs" },
  { dist: "core/project/init.js", name: "init-project-knowledge.mjs" },
  { dist: "core/project/scan.js", name: "scan-project.mjs" },
  { dist: "core/project/status.js", name: "status-report.mjs" },
  { dist: "core/governance/lint.js", name: "lint-project-knowledge.mjs" },
  { dist: "core/governance/govern.js", name: "govern-project-knowledge.mjs" },
  { dist: "core/graph/build.js", name: "build-project-graph-data.mjs" },
  { dist: "core/graph/page.js", name: "build-project-graph-page.mjs" },
  { dist: "core/knowledge/graph-model.js", name: "knowledge-lib.mjs" },
  { dist: "core/knowledge/evidence.js", name: "evidence-paths.mjs" },
  { dist: "core/obsidian/vault.js", name: "obsidian-lib.mjs" },
  { dist: "server/project-knowledge.js", name: "serve-project-knowledge.mjs" }
];

// 不进入 plugin 的 dist 文件（仅作为本地工具或纯辅助）
const distAllowList = new Set([
  "bin/notra.js",
  "cli/args.js",
  "cli/errors.js",
  "cli/formatters.js",
  "cli/help.js",
  "cli/output.js",
  "core/knowledge/node-path.js",
  "core/knowledge/state-lock.js",
  "core/knowledge/yaml-render.js",
  "core/platform/install.js",
  "core/platform/claude-local.js",
  "core/platform/codex-local.js",
  "core/project/doctor.js",
  "core/session/adoption-signal.js",
  "core/session/user-memory.js",
  ...wrapperMap.map((entry) => entry.dist)
]);

async function main() {
  await assertWrapperMapAlignsWithDist();
  await resetGeneratedWrappers();

  for (const entry of wrapperMap) {
    const sourceDistFile = path.join(distRoot, entry.dist);
    if (!(await exists(sourceDistFile))) {
      throw new Error(`未找到 dist 产物: ${sourceDistFile}`);
    }
    const wrapperPath = path.join(pluginScriptsDir, entry.name);
    const relativeDistPath = path.relative(path.dirname(wrapperPath), sourceDistFile).replace(/\\/g, "/");
    const importTarget = relativeDistPath.startsWith(".") ? relativeDistPath : `./${relativeDistPath}`;
    const wrapperSource = buildWrapperSource(importTarget);
    await fs.writeFile(wrapperPath, wrapperSource, "utf8");
  }

  // 把 plugin/templates 与 assets 复制到 dist/，让 dist 自含运行时资源
  for (const dirName of ["templates", "assets"]) {
    const source = path.join(pluginRoot, dirName);
    const target = path.join(distRoot, dirName);
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(source, target, { recursive: true });
  }
}

// 校验 wrapperMap 与 dist 实际产物对齐，避免 src 重命名/新增/删除时无声漂移
async function assertWrapperMapAlignsWithDist() {
  const actualDistFiles = await listDistJsFiles(distRoot);
  const expected = new Set(distAllowList);
  const unknown = actualDistFiles.filter((relative) => !expected.has(relative));
  const missing = wrapperMap
    .map((entry) => entry.dist)
    .filter((relative) => !actualDistFiles.includes(relative));

  const issues = [];
  if (missing.length > 0) {
    issues.push(`wrapperMap 引用的 dist 文件不存在: ${missing.join(", ")}`);
  }
  if (unknown.length > 0) {
    issues.push(
      `dist 中存在未声明的 .js（请更新 wrapperMap 或 distAllowList）: ${unknown.join(", ")}`
    );
  }

  // 检测重复名
  const seen = new Set();
  for (const entry of wrapperMap) {
    if (seen.has(entry.name)) {
      issues.push(`wrapperMap 重复名: ${entry.name}`);
    }
    seen.add(entry.name);
  }

  if (issues.length > 0) {
    throw new Error(`build-plugin-scripts 配置漂移:\n  - ${issues.join("\n  - ")}`);
  }
}

// 仅遍历 tsc 编译产物（跳过复制进来的静态资源）
const DIST_RESOURCE_DIRS = new Set(["assets", "templates"]);

async function listDistJsFiles(rootDir, current = rootDir) {
  const result = [];
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`dist 目录不存在: ${rootDir}（请先运行 tsc）`);
    }
    throw error;
  }
  for (const entry of entries) {
    if (current === rootDir && entry.isDirectory() && DIST_RESOURCE_DIRS.has(entry.name)) {
      continue;
    }
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) {
      result.push(...await listDistJsFiles(rootDir, abs));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      result.push(path.relative(rootDir, abs).replace(/\\/g, "/"));
    }
  }
  return result;
}

async function resetGeneratedWrappers() {
  // 原子重建：先删除全部已知 lib mjs（保留 notra-*.mjs / shared.mjs），再重新生成
  await fs.mkdir(pluginScriptsDir, { recursive: true });
  for (const entry of wrapperMap) {
    await fs.rm(path.join(pluginScriptsDir, entry.name), { force: true });
  }
}

function buildWrapperSource(importTarget) {
  return [
    "#!/usr/bin/env node",
    "// 由 scripts/build-plugin-scripts.mjs 自动生成。请勿手工编辑。",
    "",
    `export * from "${importTarget}";`,
    ""
  ].join("\n");
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
  console.log(`已从 dist 生成 ${wrapperMap.length} 个 plugin scripts。`);
}
