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
