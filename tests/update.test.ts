import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildInstallArgs,
  buildInstallCommand,
  NOTRA_PACKAGE_NAME,
  readCurrentVersion,
  resolveTargetVersion,
  runUpdate
} from "../dist/core/maintenance/update.js";

test("buildInstallArgs uses correct flag per package manager", () => {
  assert.deepEqual(buildInstallArgs("pnpm", "0.2.0"), ["add", "-g", `${NOTRA_PACKAGE_NAME}@0.2.0`]);
  assert.deepEqual(buildInstallArgs("npm", "0.2.0"), ["i", "-g", `${NOTRA_PACKAGE_NAME}@0.2.0`]);
  assert.deepEqual(buildInstallArgs("yarn", "0.2.0"), ["global", "add", `${NOTRA_PACKAGE_NAME}@0.2.0`]);
  assert.deepEqual(buildInstallArgs("bun", "0.2.0"), ["add", "-g", `${NOTRA_PACKAGE_NAME}@0.2.0`]);
});

test("buildInstallCommand returns null when package manager is absent", () => {
  assert.equal(buildInstallCommand(null, "0.2.0"), null);
});

test("buildInstallCommand joins program + args", () => {
  assert.equal(buildInstallCommand("pnpm", "0.2.0"), `pnpm add -g ${NOTRA_PACKAGE_NAME}@0.2.0`);
  assert.equal(buildInstallCommand("npm", "0.2.0"), `npm i -g ${NOTRA_PACKAGE_NAME}@0.2.0`);
});

test("resolveTargetVersion accepts explicit semver", async () => {
  assert.equal(await resolveTargetVersion("0.2.0"), "0.2.0");
  assert.equal(await resolveTargetVersion("1.2.3-beta.4"), "1.2.3-beta.4");
});

test("resolveTargetVersion rejects empty / nonsense inputs", async () => {
  await assert.rejects(() => resolveTargetVersion("  "), /更新目标不能为空/);
  await assert.rejects(() => resolveTargetVersion("foo-bar"), /无效的更新目标/);
});

test("resolveTargetVersion(latest) reads from injected fetch", async () => {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ version: "9.9.9" })
  })) as any;
  const version = await resolveTargetVersion("latest", { fetchImpl });
  assert.equal(version, "9.9.9");
});

test("runUpdate returns no-op when already on target version", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "notra-update-noop-"));
  await fs.writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ version: "0.2.0" }), "utf8");

  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ version: "0.2.0" })
  })) as any;

  const result = await runUpdate({
    target: "latest",
    packageRoot: tempRoot,
    fetchImpl
  });

  assert.equal(result.mode, "no-op");
  assert.equal(result.currentVersion, "0.2.0");
  assert.equal(result.targetVersion, "0.2.0");
});

test("runUpdate dry-run reports command without spawning", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "notra-update-dryrun-"));
  await fs.writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ version: "0.1.0" }), "utf8");

  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ version: "0.2.0" })
  })) as any;

  const result = await runUpdate({
    target: "latest",
    dryRun: true,
    packageManager: "pnpm",
    packageRoot: tempRoot,
    fetchImpl
  });

  assert.equal(result.mode, "dry-run");
  assert.equal(result.command, `pnpm add -g ${NOTRA_PACKAGE_NAME}@0.2.0`);
  assert.match(result.message, /dry-run/);
});

test("runUpdate dry-run with explicit version skips registry fetch", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "notra-update-explicit-"));
  await fs.writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ version: "0.1.0" }), "utf8");

  // 显式版本号应当不调用 fetchImpl；用 throw 来证明
  const fetchImpl = (async () => {
    throw new Error("fetchImpl should not be invoked for explicit version");
  }) as any;

  const result = await runUpdate({
    target: "0.3.0",
    dryRun: true,
    packageManager: "npm",
    packageRoot: tempRoot,
    fetchImpl
  });

  assert.equal(result.mode, "dry-run");
  assert.equal(result.targetVersion, "0.3.0");
  assert.equal(result.command, `npm i -g ${NOTRA_PACKAGE_NAME}@0.3.0`);
});

test("readCurrentVersion reads package.json version", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "notra-update-read-"));
  await fs.writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ version: "1.2.3" }), "utf8");
  assert.equal(await readCurrentVersion(tempRoot), "1.2.3");
});
