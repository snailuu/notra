import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(".");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8")
);

test("repository exposes a root skill shell", () => {
  assert.equal(fs.existsSync(path.join(root, "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(root, "templates")), true);
  assert.equal(fs.existsSync(path.join(root, "scripts")), true);
});

test("package.json exposes project knowledge skill commands", () => {
  assert.equal(typeof packageJson.scripts["notra:init"], "string");
  assert.equal(typeof packageJson.scripts["notra:preflight"], "string");
  assert.equal(typeof packageJson.scripts["notra:status"], "string");
  assert.equal(typeof packageJson.scripts["notra:graph"], "string");
  assert.equal(typeof packageJson.scripts["notra:crystallize"], "string");
  assert.equal(typeof packageJson.scripts["notra:auto-crystallize"], "string");
  assert.equal(typeof packageJson.scripts["notra:lint"], "string");
  assert.equal(typeof packageJson.scripts["notra:govern"], "string");
  assert.equal(typeof packageJson.scripts["notra:serve"], "string");
  assert.match(packageJson.scripts["notra:init"], /init-project-knowledge/);
  assert.match(packageJson.scripts["notra:preflight"], /preflight-session/);
  assert.match(packageJson.scripts["notra:status"], /status-report/);
  assert.match(packageJson.scripts["notra:graph"], /build-project-graph-data/);
  assert.match(packageJson.scripts["notra:crystallize"], /crystallize-session/);
  assert.match(packageJson.scripts["notra:auto-crystallize"], /auto-crystallize-session/);
  assert.match(packageJson.scripts["notra:lint"], /lint-project-knowledge/);
  assert.match(packageJson.scripts["notra:govern"], /govern-project-knowledge/);
  assert.match(packageJson.scripts["notra:serve"], /serve-project-knowledge/);
});
