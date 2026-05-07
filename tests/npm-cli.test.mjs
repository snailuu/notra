import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  installNotraPlatforms,
  normalizePlatforms
} from "../scripts/platform-installers.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(".");
const cliPath = path.join(root, "bin", "notra.mjs");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

test("normalizePlatforms defaults to shared agents skills", () => {
  assert.deepEqual(normalizePlatforms([]), ["agents"]);
  assert.deepEqual(normalizePlatforms(["all"]), ["claude", "codex", "agents"]);
  assert.throws(() => normalizePlatforms(["cursor"]), /不支持的平台/);
});

test("installNotraPlatforms writes runtime files and selected platform skills", async () => {
  const projectRoot = await createTempProject();
  const result = await installNotraPlatforms({
    projectRoot,
    packageRoot: root,
    platforms: ["codex", "agents"]
  });

  assert.deepEqual(result.platforms, ["codex", "agents"]);
  assert.equal(await exists(path.join(projectRoot, ".notra", "plugin", "scripts", "notra-init.mjs")), true);
  assert.equal(await exists(path.join(projectRoot, ".notra", "plugin", "assets", "graph", "knowledge-graph.js")), true);
  assert.equal(await exists(path.join(projectRoot, ".codex", "skills", "notra-init", "SKILL.md")), true);
  assert.equal(await exists(path.join(projectRoot, ".agents", "skills", "notra-status", "SKILL.md")), true);
  assert.equal(await exists(path.join(projectRoot, ".claude", "skills", "notra-init", "SKILL.md")), false);

  const skillSource = await fs.readFile(
    path.join(projectRoot, ".codex", "skills", "notra-init", "SKILL.md"),
    "utf8"
  );
  assert.match(skillSource, /node \.notra\/plugin\/scripts\/notra-init\.mjs/);
  assert.doesNotMatch(skillSource, /\.\.\/\.\.\/scripts/);
});

test("installNotraPlatforms dry-run reports writes without touching disk", async () => {
  const projectRoot = await createTempProject();
  const result = await installNotraPlatforms({
    projectRoot,
    packageRoot: root,
    platforms: ["claude"],
    dryRun: true
  });

  assert.equal(result.writes.length > 0, true);
  assert.equal(await exists(path.join(projectRoot, ".notra")), false);
  assert.equal(await exists(path.join(projectRoot, ".claude")), false);
});

test("installNotraPlatforms handles conflicting files with skip-existing or force", async () => {
  const projectRoot = await createTempProject();
  const skillPath = path.join(projectRoot, ".agents", "skills", "notra-init", "SKILL.md");
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, "custom skill", "utf8");

  await assert.rejects(
    installNotraPlatforms({
      projectRoot,
      packageRoot: root,
      platforms: ["agents"]
    }),
    /目标文件已存在且内容不同/
  );

  const skipped = await installNotraPlatforms({
    projectRoot,
    packageRoot: root,
    platforms: ["agents"],
    skipExisting: true
  });
  assert.equal(skipped.skipped.some((item) => item.reason === "exists"), true);
  assert.equal(await fs.readFile(skillPath, "utf8"), "custom skill");

  await installNotraPlatforms({
    projectRoot,
    packageRoot: root,
    platforms: ["agents"],
    force: true
  });
  assert.match(await fs.readFile(skillPath, "utf8"), /node \.notra\/plugin\/scripts\/notra-init\.mjs/);
});

test("notra CLI exposes version and init", async () => {
  const projectRoot = await createTempProject();
  const version = await execFileAsync(process.execPath, [cliPath, "--version"]);
  assert.equal(version.stdout.trim(), packageJson.version);

  const init = await execFileAsync(process.execPath, [
    cliPath,
    "init",
    "--codex",
    "--project-root",
    projectRoot
  ]);
  assert.match(init.stdout, /已初始化 notra 平台配置: codex/);
  assert.equal(await exists(path.join(projectRoot, ".codex", "skills", "notra-init", "SKILL.md")), true);
});

test("notra CLI runs project knowledge subcommands", async () => {
  const projectRoot = await createSampleProject();

  const init = await execFileAsync(process.execPath, [cliPath, "project-init", projectRoot]);
  const initPayload = JSON.parse(init.stdout);
  assert.equal(initPayload.projectRoot, projectRoot);
  assert.equal(await exists(path.join(projectRoot, ".notra", "project-profile.md")), true);

  const status = await execFileAsync(process.execPath, [cliPath, "status", projectRoot]);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.knowledgeRoot, path.join(projectRoot, ".notra"));

  const preflight = await execFileAsync(process.execPath, [
    cliPath,
    "preflight",
    projectRoot,
    "实现 HTTP 调用"
  ]);
  const preflightPayload = JSON.parse(preflight.stdout);
  assert.notEqual(preflightPayload.mode, "no-knowledge");

  const graph = await execFileAsync(process.execPath, [cliPath, "graph", projectRoot]);
  const graphPayload = JSON.parse(graph.stdout);
  assert.equal(graphPayload.output.data, "graph/graph-data.json");

  const lint = await execFileAsync(process.execPath, [cliPath, "lint", projectRoot]);
  const lintPayload = JSON.parse(lint.stdout);
  assert.equal(typeof lintPayload.summary.issue_count, "number");
});

async function createSampleProject() {
  const projectRoot = await createTempProject();
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "sample-project", type: "module" }, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(projectRoot, "src", "client.js"),
    "export async function request(url) { return fetch(url); }\n",
    "utf8"
  );
  return projectRoot;
}

async function createTempProject() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "notra-cli-test-"));
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
