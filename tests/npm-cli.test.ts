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
} from "../dist/core/platform/install.js";
import {
  readRuntimeManifest,
  removeRuntimeManifest,
  simulatePreviousInstall
} from "./runtime-manifest-fixture.ts";

const execFileAsync = promisify(execFile);
const root = path.resolve(".");
const cliPath = path.join(root, "bin", "notra.mjs");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

test("normalizePlatforms defaults to shared agents skills", () => {
  assert.deepEqual(normalizePlatforms([]), ["agents"]);
  assert.deepEqual(normalizePlatforms(["all"]), ["claude", "codex", "agents"]);
  assert.throws(() => normalizePlatforms(["cursor" as any]), /不支持的平台/);
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

test("installNotraPlatforms preserves user-edited platform skills instead of overwriting them", async () => {
  const projectRoot = await createTempProject();
  const skillPath = path.join(projectRoot, ".agents", "skills", "notra-init", "SKILL.md");
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, "custom skill", "utf8");

  const preserved = await installNotraPlatforms({
    projectRoot,
    packageRoot: root,
    platforms: ["agents"]
  });
  assert.equal(
    preserved.skipped.some((item) => item.path === skillPath && item.reason === "diverged"),
    true
  );
  assert.equal(await fs.readFile(skillPath, "utf8"), "custom skill");

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

test("installNotraPlatforms refreshes files it wrote itself when the source moved on", async () => {
  const projectRoot = await createTempProject();
  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  // manifest 记下这份旧内容出自 notra，因此它是版本陈旧而非用户改动
  const runtimeRelative = path.join(".notra", "plugin", "scripts", "shared.mjs");
  const skillRelative = path.join(".agents", "skills", "notra-init", "SKILL.md");
  await simulatePreviousInstall(projectRoot, runtimeRelative, "// v0.1.0 的 runtime");
  await simulatePreviousInstall(projectRoot, skillRelative, "# v0.1.0 的 skill");

  const refreshed = await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  for (const relative of [runtimeRelative, skillRelative]) {
    const target = path.join(projectRoot, relative);
    assert.equal(
      refreshed.writes.some((item) => item.path === target && item.action === "overwrite"),
      true,
      `${relative} 应被刷新`
    );
  }
  assert.equal(
    await fs.readFile(path.join(projectRoot, runtimeRelative), "utf8"),
    await fs.readFile(path.join(root, "plugins", "notra", "scripts", "shared.mjs"), "utf8")
  );
});

test("installNotraPlatforms keeps a file the user edited after notra wrote it", async () => {
  const projectRoot = await createTempProject();
  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  // 只改文件、不动 manifest：哈希对不上记录，说明是用户改的
  const runtimeScript = path.join(projectRoot, ".notra", "plugin", "scripts", "shared.mjs");
  const skillPath = path.join(projectRoot, ".agents", "skills", "notra-init", "SKILL.md");
  await fs.writeFile(runtimeScript, "// 我打的本地补丁", "utf8");
  await fs.writeFile(skillPath, "# 我改过的 skill", "utf8");

  const result = await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  assert.equal(result.skipped.some((item) => item.path === runtimeScript && item.reason === "diverged"), true);
  assert.equal(result.skipped.some((item) => item.path === skillPath && item.reason === "diverged"), true);
  assert.equal(await fs.readFile(runtimeScript, "utf8"), "// 我打的本地补丁");
  assert.equal(await fs.readFile(skillPath, "utf8"), "# 我改过的 skill");
});

test("installNotraPlatforms refreshes a legacy install that predates the manifest", async () => {
  const projectRoot = await createTempProject();
  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  const runtimeScript = path.join(projectRoot, ".notra", "plugin", "scripts", "shared.mjs");
  const skillPath = path.join(projectRoot, ".agents", "skills", "notra-init", "SKILL.md");
  await fs.writeFile(runtimeScript, "// 旧版 runtime", "utf8");
  await fs.writeFile(skillPath, "# 旧版 skill", "utf8");
  await removeRuntimeManifest(projectRoot);

  const result = await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  // 没有 manifest 时按地界猜：runtime 是 vendored 产物直接刷新，skill 在用户地界保守保留
  assert.equal(result.writes.some((item) => item.path === runtimeScript && item.action === "overwrite"), true);
  assert.equal(result.skipped.some((item) => item.path === skillPath && item.reason === "diverged"), true);
});

test("installNotraPlatforms refuses to run against a corrupt manifest", async () => {
  const projectRoot = await createTempProject();
  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  // 静默退回 legacy 会把用户对 runtime 的改动当成陈旧副本覆盖掉，所以损坏必须报错而不是降级
  const manifestPath = path.join(projectRoot, ".notra", "plugin", ".manifest.json");
  await fs.writeFile(manifestPath, "{ 截断的 JSON", "utf8");
  const runtimeScript = path.join(projectRoot, ".notra", "plugin", "scripts", "shared.mjs");
  await fs.writeFile(runtimeScript, "// 我的补丁", "utf8");

  await assert.rejects(
    installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] }),
    /运行时清单已损坏/
  );
  assert.equal(await fs.readFile(runtimeScript, "utf8"), "// 我的补丁");
});

test("installNotraPlatforms records a manifest covering runtime and skill files", async () => {
  const projectRoot = await createTempProject();
  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  const manifest = await readRuntimeManifest(projectRoot);

  assert.equal(typeof manifest.notraVersion, "string");
  assert.equal(manifest.files[path.join(".notra", "plugin", "scripts", "shared.mjs")]?.length, 64);
  assert.equal(manifest.files[path.join(".agents", "skills", "notra-init", "SKILL.md")]?.length, 64);
});

test("installNotraPlatforms does not write a manifest during dry-run", async () => {
  const projectRoot = await createTempProject();

  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"], dryRun: true });

  assert.equal(await exists(path.join(projectRoot, ".notra")), false);
});

test("installNotraPlatforms lets skip-existing win over runtime refresh", async () => {
  const projectRoot = await createTempProject();
  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  const runtimeRelative = path.join(".notra", "plugin", "scripts", "shared.mjs");
  await simulatePreviousInstall(projectRoot, runtimeRelative, "// 旧版 runtime");
  const runtimeScript = path.join(projectRoot, runtimeRelative);

  const result = await installNotraPlatforms({
    projectRoot,
    packageRoot: root,
    platforms: ["agents"],
    skipExisting: true
  });

  assert.equal(result.skipped.some((item) => item.path === runtimeScript && item.reason === "exists"), true);
  assert.equal(await fs.readFile(runtimeScript, "utf8"), "// 旧版 runtime");
});

test("installNotraPlatforms can still refresh a runtime that skip-existing left behind", async () => {
  const projectRoot = await createTempProject();
  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  const runtimeRelative = path.join(".notra", "plugin", "scripts", "shared.mjs");
  await simulatePreviousInstall(projectRoot, runtimeRelative, "// 旧版 runtime");
  const runtimeScript = path.join(projectRoot, runtimeRelative);

  // 跳过写入时若把「本次想写的新版哈希」记进 manifest，磁盘上的旧内容下次就会被误判成用户改动
  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"], skipExisting: true });
  const refreshed = await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  assert.equal(refreshed.writes.some((item) => item.path === runtimeScript && item.action === "overwrite"), true);
  assert.equal(
    await fs.readFile(runtimeScript, "utf8"),
    await fs.readFile(path.join(root, "plugins", "notra", "scripts", "shared.mjs"), "utf8")
  );
});

test("installNotraPlatforms keeps protecting a user edit across repeated installs", async () => {
  const projectRoot = await createTempProject();
  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  const skillPath = path.join(projectRoot, ".agents", "skills", "notra-init", "SKILL.md");
  await fs.writeFile(skillPath, "# 我的定制", "utf8");

  // 跳过写入时若改记「磁盘现有内容」的哈希，用户改动会在下一轮被认作 notra 自己的文件而遭覆盖
  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });
  const second = await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  assert.equal(second.skipped.some((item) => item.path === skillPath && item.reason === "diverged"), true);
  assert.equal(await fs.readFile(skillPath, "utf8"), "# 我的定制");
});

test("notra CLI exposes version and platform-only init", async () => {
  const projectRoot = await createTempProject();
  const version = await execFileAsync(process.execPath, [cliPath, "--version"]);
  assert.equal(version.stdout.trim(), packageJson.version);

  const init = await execFileAsync(process.execPath, [
    cliPath,
    "init",
    "--platform-only",
    "--codex",
    "--project-root",
    projectRoot
  ]);
  assert.match(init.stdout, /Notra 初始化完成/);
  assert.match(init.stdout, /平台配置: codex/);
  assert.equal(await exists(path.join(projectRoot, ".codex", "skills", "notra-init", "SKILL.md")), true);
  assert.equal(await exists(path.join(projectRoot, ".notra", "project-profile.md")), false);
});

test("notra CLI one-shot init initializes platform and project knowledge", async () => {
  const projectRoot = await createSampleProject();

  const init = await execFileAsync(process.execPath, [
    cliPath,
    "init",
    "--yes",
    "--project-root",
    projectRoot
  ]);
  assert.match(init.stdout, /Notra 初始化完成/);
  assert.match(init.stdout, /平台配置: agents/);
  assert.match(init.stdout, /知识库:/);
  assert.equal(await exists(path.join(projectRoot, ".agents", "skills", "notra-init", "SKILL.md")), true);
  assert.equal(await exists(path.join(projectRoot, ".notra", "project-profile.md")), true);
});

test("notra CLI init is re-entrant on a legacy install with a stale runtime", async () => {
  const projectRoot = await createSampleProject();
  await execFileAsync(process.execPath, [cliPath, "init", "--yes", "--project-root", projectRoot]);

  // 复刻真实仓库的状态：manifest 出现之前装的项目，runtime 已陈旧；另留一段用户手写的知识库内容
  const runtimeScript = path.join(projectRoot, ".notra", "plugin", "scripts", "shared.mjs");
  const profilePath = path.join(projectRoot, ".notra", "project-profile.md");
  await fs.writeFile(runtimeScript, "// 上一个 notra 版本留下的 runtime", "utf8");
  await removeRuntimeManifest(projectRoot);
  await fs.appendFile(profilePath, "\n用户手写的项目画像补充\n", "utf8");

  const init = await execFileAsync(process.execPath, [cliPath, "init", "--yes", "--project-root", projectRoot]);

  assert.match(init.stdout, /刷新运行时/);
  assert.equal(
    await fs.readFile(runtimeScript, "utf8"),
    await fs.readFile(path.join(root, "plugins", "notra", "scripts", "shared.mjs"), "utf8")
  );
  assert.match(await fs.readFile(profilePath, "utf8"), /用户手写的项目画像补充/);
});

test("notra CLI init never labels an overwritten user skill as a runtime refresh", async () => {
  const projectRoot = await createSampleProject();
  await execFileAsync(process.execPath, [cliPath, "init", "--yes", "--platform-only", "--project-root", projectRoot]);

  const skillPath = path.join(projectRoot, ".agents", "skills", "notra-init", "SKILL.md");
  await fs.writeFile(skillPath, "# 我改过的 skill", "utf8");

  const forced = await execFileAsync(process.execPath, [
    cliPath, "init", "--yes", "--platform-only", "--force", "--project-root", projectRoot
  ]);

  assert.doesNotMatch(forced.stdout, /刷新运行时/);
  assert.match(forced.stdout, /刷新 skill: 1 个文件/);
});

test("notra CLI init supports json and dry-run", async () => {
  const projectRoot = await createSampleProject();

  const init = await execFileAsync(process.execPath, [
    cliPath,
    "init",
    "--yes",
    "--json",
    "--dry-run",
    "--project-root",
    projectRoot
  ]);
  const payload = JSON.parse(init.stdout);
  assert.equal(payload.projectRoot, projectRoot);
  assert.equal(payload.platformInstall.dryRun, true);
  assert.equal(payload.projectKnowledge.dryRun, true);
  assert.equal(payload.platformInstall.writes.length > 0, true);
  assert.equal(payload.projectKnowledge.writes.length > 0, true);
  assert.equal(await exists(path.join(projectRoot, ".agents")), false);
  assert.equal(await exists(path.join(projectRoot, ".notra")), false);
});

test("notra CLI runs project knowledge subcommands", async () => {
  const projectRoot = await createSampleProject();

  const init = await execFileAsync(process.execPath, [cliPath, "project-init", projectRoot, "--json"]);
  const initPayload = JSON.parse(init.stdout);
  assert.equal(initPayload.projectRoot, projectRoot);
  assert.equal(await exists(path.join(projectRoot, ".notra", "project-profile.md")), true);

  const status = await execFileAsync(process.execPath, [cliPath, "status", projectRoot, "--json"]);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.knowledgeRoot, path.join(projectRoot, ".notra"));

  const preflight = await execFileAsync(process.execPath, [
    cliPath,
    "preflight",
    projectRoot,
    "实现 HTTP 调用",
    "--json"
  ]);
  const preflightPayload = JSON.parse(preflight.stdout);
  assert.notEqual(preflightPayload.mode, "no-knowledge");

  const graph = await execFileAsync(process.execPath, [cliPath, "graph", projectRoot, "--json"]);
  const graphPayload = JSON.parse(graph.stdout);
  assert.equal(graphPayload.output.data, "graph/graph-data.json");

  const lint = await execFileAsync(process.execPath, [cliPath, "lint", projectRoot, "--json"]);
  const lintPayload = JSON.parse(lint.stdout);
  assert.equal(typeof lintPayload.summary.issue_count, "number");
});

test("notra CLI runs start finish and doctor workflow", async () => {
  const projectRoot = await createSampleProject();

  await execFileAsync(process.execPath, [cliPath, "init", "--yes", "--project-root", projectRoot]);

  const start = await execFileAsync(process.execPath, [
    cliPath,
    "start",
    projectRoot,
    "实现 HTTP 调用"
  ]);
  assert.match(start.stdout, /命中已有项目知识|未命中已有知识/);

  const startJson = await execFileAsync(process.execPath, [
    cliPath,
    "start",
    projectRoot,
    "实现 HTTP 调用",
    "--json"
  ]);
  assert.notEqual(JSON.parse(startJson.stdout).mode, "no-knowledge");

  const finish = await execFileAsync(process.execPath, [
    cliPath,
    "finish",
    projectRoot,
    "完成 HTTP 调用封装"
  ]);
  assert.match(finish.stdout, /任务知识沉淀完成/);
  assert.match(finish.stdout, /Git touched files 采集不完整/);
  assert.equal((await fs.readdir(path.join(projectRoot, ".notra", "sessions"))).some((name) => name.endsWith(".md")), true);

  const finishJson = await execFileAsync(process.execPath, [
    cliPath,
    "finish",
    projectRoot,
    "完成 HTTP 调用封装",
    "--json"
  ]);
  const finishPayload = JSON.parse(finishJson.stdout);
  assert.equal(finishPayload.ok, true);
  assert.equal(typeof finishPayload.lint.summary.issue_count, "number");

  const doctor = await execFileAsync(process.execPath, [cliPath, "doctor", projectRoot]);
  assert.match(doctor.stdout, /Notra doctor/);

  const doctorJson = await execFileAsync(process.execPath, [cliPath, "doctor", projectRoot, "--json"]);
  const doctorPayload = JSON.parse(doctorJson.stdout);
  assert.equal(Array.isArray(doctorPayload.checks), true);
  assert.equal(typeof doctorPayload.summary.fail, "number");
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
