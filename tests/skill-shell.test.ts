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

test("package.json exposes only npm maintenance scripts", () => {
  const scriptNames = Object.keys(packageJson.scripts);

  assert.equal(scriptNames.some((name) => name.startsWith("notra:")), false);
  assert.equal(typeof packageJson.scripts.test, "string");
  assert.equal(typeof packageJson.scripts.publish, "string");
});

test("TypeScript build output does not keep stale flat scripts", () => {
  assert.equal(fs.existsSync(path.join(root, "dist", "scripts")), false);
  assert.equal(fs.existsSync(path.join(root, "dist", "core")), true);
  assert.equal(fs.existsSync(path.join(root, "dist", "server")), true);
});
