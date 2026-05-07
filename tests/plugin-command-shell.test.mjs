import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(".");
const marketplacePath = path.join(root, ".agents", "plugins", "marketplace.json");
const pluginRoot = path.join(root, "plugins", "notra");
const pluginManifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const pluginManifest = JSON.parse(fs.readFileSync(pluginManifestPath, "utf8"));
const readmePath = path.join(root, "README.md");
const rootSkillPath = path.join(root, "SKILL.md");
const commandDirectory = path.join(pluginRoot, "commands");
const skillsDirectory = path.join(pluginRoot, "skills");
const initFixtureRoot = path.resolve("tests", "fixtures", "init-sample-project");

test("repository exposes a local Codex marketplace for the notra plugin", () => {
  assert.equal(fs.existsSync(marketplacePath), true);
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));

  assert.equal(marketplace.name, "notra");
  assert.equal(marketplace.interface.displayName, "Notra");
  assert.equal(Array.isArray(marketplace.plugins), true);

  const notraPlugin = marketplace.plugins.find((plugin) => plugin.name === "notra");
  assert.ok(notraPlugin);
  assert.deepEqual(notraPlugin.source, {
    source: "local",
    path: "./plugins/notra"
  });
  assert.deepEqual(notraPlugin.policy, {
    installation: "AVAILABLE",
    authentication: "ON_INSTALL"
  });
  assert.equal(notraPlugin.category, "Productivity");
});

test("repository docs expose notra as a skill-based workflow", () => {
  const readme = fs.readFileSync(readmePath, "utf8");
  const rootSkill = fs.readFileSync(rootSkillPath, "utf8");

  assert.doesNotMatch(readme, /\/notra:/);
  assert.match(readme, /notra:notra-init/);
  assert.match(readme, /notra:notra-status/);

  assert.doesNotMatch(rootSkill, /\/notra:/);
  assert.match(rootSkill, /notra:notra-init/);
  assert.match(rootSkill, /notra:notra-graph/);
});

test("notra plugin manifest exposes skill-bundle metadata", () => {
  assert.equal(fs.existsSync(pluginManifestPath), true);

  assert.equal(pluginManifest.name, "notra");
  assert.equal(pluginManifest.skills, "./skills/");
  assert.equal(pluginManifest.interface.displayName, "Notra");
  assert.equal(pluginManifest.interface.category, "Productivity");
  assert.doesNotMatch(pluginManifest.description, /command shell/i);
  assert.doesNotMatch(pluginManifest.interface.shortDescription, /command shell/i);
  assert.doesNotMatch(pluginManifest.interface.longDescription, /\/notra:/);
  assert.deepEqual(pluginManifest.interface.defaultPrompt, [
    "Use the `notra:notra-init` skill to initialize `.notra/` for the current project.",
    "Use the `notra:notra-preflight` skill before implementation to retrieve matching practices or local evidence hints.",
    "Use the `notra:notra-status` skill to summarize the current project knowledge state.",
    "Use the `notra:notra-crystallize` skill to persist stable knowledge from the current session.",
    "Use the `notra:notra-auto-crystallize` skill after task completion to infer adopted practices or incubating candidates from the task and touched files.",
    "Use the `notra:notra-lint` skill to inspect recommendation-pool lifecycle governance, evidence health, and possible duplicates.",
    "Use the `notra:notra-govern` skill to automatically apply reversible project knowledge governance actions."
  ]);
});

test("notra plugin no longer relies on slash-command docs", () => {
  const commands = ["init", "status", "graph", "crystallize", "serve"];

  for (const command of commands) {
    const commandPath = path.join(commandDirectory, `${command}.md`);
    assert.equal(fs.existsSync(commandPath), false);
  }
});

test("notra plugin exposes skill wrapper docs without slash-command wording", () => {
  const skills = [
    ["notra-init", "init-project-knowledge.mjs"],
    ["notra-preflight", "preflight-session.mjs"],
    ["notra-status", "status-report.mjs"],
    ["notra-graph", "build-project-graph-data.mjs"],
    ["notra-crystallize", "crystallize-session.mjs"],
    ["notra-auto-crystallize", "auto-crystallize-session.mjs"],
    ["notra-lint", "lint-project-knowledge.mjs"],
    ["notra-govern", "govern-project-knowledge.mjs"],
    ["notra-serve", "serve-project-knowledge.mjs"]
  ];

  for (const [skillName, scriptName] of skills) {
    const skillPath = path.join(skillsDirectory, skillName, "SKILL.md");
    assert.equal(fs.existsSync(skillPath), true);
    const source = fs.readFileSync(skillPath, "utf8");
    assert.match(source, new RegExp(`name:\\s*${skillName}`));
    assert.match(source, new RegExp(scriptName.replace(".", "\\.")));
    assert.doesNotMatch(source, /\/notra:/);
    assert.match(source, /skill/i);
  }
});

test("notra init wrapper stays runnable after copying the plugin into a cache-style layout", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "notra-plugin-cache-"));
  const cachedPluginRoot = path.join(
    tempRoot,
    "cache",
    "notra",
    "notra",
    pluginManifest.version
  );
  const projectRoot = path.join(tempRoot, "sample-project");

  await fsp.cp(pluginRoot, cachedPluginRoot, { recursive: true });
  await fsp.cp(initFixtureRoot, projectRoot, { recursive: true });

  await import(pathToFileURL(path.join(cachedPluginRoot, "scripts", "notra-init.mjs")).href);
  const { initializeProjectKnowledge } = await import(
    pathToFileURL(path.join(cachedPluginRoot, "scripts", "init-project-knowledge.mjs")).href
  );

  await initializeProjectKnowledge(projectRoot);

  assert.equal(
    fs.existsSync(path.join(projectRoot, ".notra", "graph", "knowledge-graph.html")),
    true
  );

  const workflow = fs.readFileSync(
    path.join(projectRoot, ".notra", "workflow.md"),
    "utf8"
  );
  assert.doesNotMatch(workflow, /\/notra:/);
  assert.match(workflow, /notra:notra-status/);
  assert.match(workflow, /notra:notra-graph/);
});

test("plugin script and graph resource copies stay in sync with root sources", async () => {
  await assertDirectoriesMatch(
    path.join(root, "assets", "graph"),
    path.join(pluginRoot, "assets", "graph")
  );

  for (const scriptName of [
    "auto-crystallize-session.mjs",
    "build-project-graph-data.mjs",
    "build-project-graph-page.mjs",
    "crystallize-session.mjs",
    "evidence-paths.mjs",
    "govern-project-knowledge.mjs",
    "init-project-knowledge.mjs",
    "knowledge-lib.mjs",
    "lint-project-knowledge.mjs",
    "obsidian-lib.mjs",
    "preflight-session.mjs",
    "scan-project.mjs",
    "serve-project-knowledge.mjs",
    "status-report.mjs"
  ]) {
    assert.equal(
      await fsp.readFile(path.join(root, "scripts", scriptName), "utf8"),
      await fsp.readFile(path.join(pluginRoot, "scripts", scriptName), "utf8"),
      `${scriptName} should match plugin copy`
    );
  }
});

async function assertDirectoriesMatch(leftDirectory, rightDirectory) {
  const leftFiles = await collectFiles(leftDirectory, leftDirectory);
  const rightFiles = await collectFiles(rightDirectory, rightDirectory);
  assert.deepEqual(leftFiles, rightFiles);

  for (const relativePath of leftFiles) {
    assert.equal(
      await fsp.readFile(path.join(leftDirectory, relativePath), "utf8"),
      await fsp.readFile(path.join(rightDirectory, relativePath), "utf8"),
      `${relativePath} should match plugin copy`
    );
  }
}

async function collectFiles(rootDirectory, currentDirectory) {
  const entries = await fsp.readdir(currentDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(rootDirectory, absolutePath));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDirectory, absolutePath).replace(/\\/g, "/"));
    }
  }
  return files.sort();
}
