import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { initializeProjectKnowledge } from "../dist/core/project/init.js";

const fixtureRoot = path.resolve("tests", "fixtures", "init-sample-project");

test("initializeProjectKnowledge bootstraps .notra from local code and docs", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "project-knowledge-init-"));
  const projectRoot = path.join(tempRoot, "sample-project");

  await fs.cp(fixtureRoot, projectRoot, { recursive: true });
  await fs.mkdir(path.join(projectRoot, ".worktrees", "feature", "src", "api"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, ".worktrees", "feature", "src", "api", "client.ts"),
    "export const ignoredClient = () => fetch('/ignored');\n",
    "utf8"
  );
  await fs.mkdir(path.join(projectRoot, "docs", "plans"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "docs", "plans", "2026-04-29-agent-plan.md"),
    "# Agent planning draft\n\n不应作为项目知识证据。\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(projectRoot, "task_plan.md"),
    "# 临时任务计划\n\n不应作为项目知识证据。\n",
    "utf8"
  );
  await fs.mkdir(path.join(projectRoot, "src", "nested"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "src", "nested", "README.md"),
    "# 嵌套 README\n\n不应作为项目文档入口。\n",
    "utf8"
  );
  await fs.mkdir(path.join(projectRoot, "src", "views", "demo"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "src", "views", "demo", "config.ts"),
    "export const tableColumns = [];\n",
    "utf8"
  );
  await fs.mkdir(path.join(projectRoot, "public", "ckeditor"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "public", "ckeditor", "config.js"),
    "window.CKEDITOR_CONFIG = {};\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(projectRoot, "src", "huge-client.ts"),
    `${"x".repeat(300 * 1024)}fetch('/too-large')\n`,
    "utf8"
  );

  const summary = await initializeProjectKnowledge(projectRoot);
  const knowledgeRoot = path.join(projectRoot, ".notra");
  const projectProfile = await fs.readFile(path.join(knowledgeRoot, "project-profile.md"), "utf8");
  const practice = await fs.readFile(
    path.join(knowledgeRoot, "practices", "practice-http-client.md"),
    "utf8"
  );
  const incubatingOption = await fs.readFile(
    path.join(knowledgeRoot, "incubating", "options", "option-direct-call.md"),
    "utf8"
  );
  const centralizedConfigOption = await fs.readFile(
    path.join(knowledgeRoot, "options", "option-centralized-config.md"),
    "utf8"
  );
  const launcherPath = path.join(knowledgeRoot, "open-graph.cmd");
  const launcherToolPath = path.join(knowledgeRoot, "tools", "notra-runtime", "server", "project-knowledge.js");
  const obsidianIndex = await fs.readFile(path.join(knowledgeRoot, "index.md"), "utf8");
  const obsidianLog = await fs.readFile(path.join(knowledgeRoot, "log.md"), "utf8");
  const practiceView = await fs.readFile(path.join(knowledgeRoot, "_views", "practices.md"), "utf8");

  assert.equal(summary.projectRoot, projectRoot);
  assert.deepEqual(summary.tech, ["typescript", "vue", "node"]);
  assert.ok(summary.stableNodeIds.includes("practice-http-client"));
  assert.ok(summary.incubatingNodeIds.includes("option-direct-call"));
  assert.match(projectProfile, /title: 示例初始化项目/);
  assert.match(projectProfile, /adopted_rules:/);
  assert.doesNotMatch(projectProfile, /docs\/engineering\.md/);
  assert.doesNotMatch(projectProfile, /docs\/plans/);
  assert.doesNotMatch(projectProfile, /task_plan\.md/);
  assert.doesNotMatch(projectProfile, /src\/nested\/README\.md/);
  assert.match(practice, /HTTP 调用封装实践/);
  assert.doesNotMatch(practice, /\.worktrees/);
  assert.doesNotMatch(practice, /huge-client/);
  assert.match(incubatingOption, /maturity: incubating/);
  assert.match(centralizedConfigOption, /src\/config\/env\.ts/);
  assert.doesNotMatch(centralizedConfigOption, /src\/views\/demo\/config\.ts/);
  assert.doesNotMatch(centralizedConfigOption, /public\/ckeditor\/config\.js/);
  assert.equal(
    await fileExists(path.join(knowledgeRoot, "graph", "graph-data.json")),
    true
  );
  assert.equal(
    await fileExists(path.join(knowledgeRoot, "graph", "knowledge-graph.html")),
    true
  );
  assert.equal(await fileExists(path.join(knowledgeRoot, ".obsidian", "app.json")), true);
  assert.equal(await fileExists(path.join(knowledgeRoot, ".obsidian", "graph.json")), true);
  assert.match(obsidianIndex, /\[\[project-profile\]\]/);
  assert.match(obsidianIndex, /\[\[practice-http-client\]\]/);
  assert.match(obsidianIndex, /\[\[option-unified-client\]\]/);
  assert.match(obsidianLog, /notra:init/);
  assert.match(practiceView, /\[\[practice-http-client\]\]/);
  assert.match(practiceView, /\[\[option-unified-client\]\]/);
  assert.equal(await fileExists(launcherPath), true);
  assert.equal(await fileExists(launcherToolPath), true);
  assert.equal(await fileExists(path.join(knowledgeRoot, "tools", "notra-runtime", "core", "governance", "govern.js")), true);
  await import(pathToFileURL(launcherToolPath).href);

  const launcher = await fs.readFile(launcherPath, "utf8");
  assert.match(launcher, /%~dp0tools\\notra-runtime\\server\\project-knowledge\.js/);
  assert.doesNotMatch(launcher, /universal-practice-knowledge-graph/);
  assert.doesNotMatch(launcher, /[A-Za-z]:\\/);
  assert.doesNotMatch(launcher, /set "NODE_EXE=.*[A-Za-z]:/);
  assert.match(launcher, /127\.0\.0\.1/);
  assert.match(launcher, /8124/);
});

test("initializeProjectKnowledge dry-run reports writes without touching disk", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "project-knowledge-init-dry-run-"));
  const projectRoot = path.join(tempRoot, "sample-project");

  await fs.cp(fixtureRoot, projectRoot, { recursive: true });

  const summary = await initializeProjectKnowledge(projectRoot, { dryRun: true });

  assert.equal(summary.dryRun, true);
  assert.equal(summary.writes.length > 0, true);
  assert.equal(await fileExists(path.join(projectRoot, ".notra")), false);
});

test("initializeProjectKnowledge does not overwrite existing knowledge by default", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "project-knowledge-init-existing-"));
  const projectRoot = path.join(tempRoot, "sample-project");
  const profilePath = path.join(projectRoot, ".notra", "project-profile.md");

  await fs.cp(fixtureRoot, projectRoot, { recursive: true });
  await initializeProjectKnowledge(projectRoot);
  await fs.writeFile(profilePath, "custom profile\n", "utf8");

  const summary = await initializeProjectKnowledge(projectRoot);

  assert.equal(summary.alreadyInitialized, true);
  assert.equal(summary.writes.length, 0);
  assert.equal(await fs.readFile(profilePath, "utf8"), "custom profile\n");
});

test("initializeProjectKnowledge handles existing knowledge with skipExisting or force", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "project-knowledge-init-force-"));
  const projectRoot = path.join(tempRoot, "sample-project");
  const profilePath = path.join(projectRoot, ".notra", "project-profile.md");

  await fs.cp(fixtureRoot, projectRoot, { recursive: true });
  await initializeProjectKnowledge(projectRoot);
  await fs.writeFile(profilePath, "custom profile\n", "utf8");

  const skipped = await initializeProjectKnowledge(projectRoot, { skipExisting: true });
  assert.equal(skipped.skipped.some((item) => item.path === profilePath && item.reason === "exists"), true);
  assert.equal(await fs.readFile(profilePath, "utf8"), "custom profile\n");

  const forced = await initializeProjectKnowledge(projectRoot, { force: true });
  assert.equal(forced.writes.some((item) => item.path === profilePath && item.action === "overwrite"), true);
  assert.match(await fs.readFile(profilePath, "utf8"), /title: 示例初始化项目/);
});

test("initializeProjectKnowledge does not create centralized config recommendations from page-level config files", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "project-knowledge-inline-config-"));
  const projectRoot = path.join(tempRoot, "inline-config-project");

  await fs.mkdir(path.join(projectRoot, "src", "views", "demo"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "inline-config-project", dependencies: { vue: "^3.0.0" } }, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(path.join(projectRoot, "README.md"), "# inline-config-project\n", "utf8");
  await fs.writeFile(
    path.join(projectRoot, "src", "views", "demo", "config.ts"),
    "export const tableColumns = [];\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(projectRoot, "src", "views", "demo", "index.vue"),
    "const mode = process.env.NODE_ENV;\n",
    "utf8"
  );

  const summary = await initializeProjectKnowledge(projectRoot);
  const knowledgeRoot = path.join(projectRoot, ".notra");
  const practice = await fs.readFile(
    path.join(knowledgeRoot, "incubating", "practices", "practice-config-management.md"),
    "utf8"
  );
  const inlineOption = await fs.readFile(
    path.join(knowledgeRoot, "incubating", "options", "option-inline-config.md"),
    "utf8"
  );

  assert.ok(summary.incubatingNodeIds.includes("practice-config-management"));
  assert.ok(summary.incubatingNodeIds.includes("option-inline-config"));
  assert.equal(
    await fileExists(path.join(knowledgeRoot, "options", "option-centralized-config.md")),
    false
  );
  assert.match(practice, /maturity: incubating/);
  assert.match(practice, /option-inline-config/);
  assert.doesNotMatch(practice, /src\/views\/demo\/config\.ts/);
  assert.match(inlineOption, /practice: practice-config-management/);
  assert.doesNotMatch(inlineOption, /option-centralized-config/);
});

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
