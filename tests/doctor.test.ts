import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installNotraPlatforms } from "../dist/core/platform/install.js";
import { runDoctor, type DoctorCheck, type DoctorReport } from "../dist/core/project/doctor.js";
import { simulatePreviousInstall } from "./runtime-manifest-fixture.ts";

const root = path.resolve(".");

test("doctor reports a freshly installed runtime as up to date", async () => {
  const projectRoot = await createTempProject();
  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  const report = await runDoctor(projectRoot, root);

  assert.equal(freshnessCheck(report).status, "pass");
  assert.equal(report.suggestions.includes("notra init --yes --platform-only"), false);
});

test("doctor detects a stale runtime that only drifted inside dist", async () => {
  const projectRoot = await createTempProject();
  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  // plugins/notra/scripts 下是 export * from dist/... 的薄壳，升级时不变，
  // 所以只有比对 dist/ 才能发现这种最常见的陈旧
  const distRelative = path.join(".notra", "plugin", "dist", "core", "project", "init.js");
  await simulatePreviousInstall(projectRoot, distRelative, "// 上一个 notra 版本留下的 dist");

  const report = await runDoctor(projectRoot, root);
  const check = freshnessCheck(report);

  assert.equal(check.status, "warn");
  const details = check.details as { staleCount: number; staleFiles: string[]; modifiedCount: number };
  assert.equal(details.staleCount, 1);
  assert.equal(details.modifiedCount, 0);
  assert.equal(details.staleFiles.some((file) => file.endsWith("init.js")), true);
  assert.equal(report.suggestions.includes("notra init --yes --platform-only"), true);
});

test("doctor detects a stale runtime script and clears after a refresh", async () => {
  const projectRoot = await createTempProject();
  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  // 让 shared.mjs 成为 notra 自己留下的陈旧副本（manifest 记账），这样 re-install 会刷新它
  await simulatePreviousInstall(projectRoot, path.join(".notra", "plugin", "scripts", "shared.mjs"), "// 旧版本");
  assert.equal(freshnessCheck(await runDoctor(projectRoot, root)).status, "warn");

  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  assert.equal(freshnessCheck(await runDoctor(projectRoot, root)).status, "pass");
});

test("doctor separates a stale runtime from one the user edited", async () => {
  const projectRoot = await createTempProject();
  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  await simulatePreviousInstall(projectRoot, path.join(".notra", "plugin", "scripts", "shared.mjs"), "// 旧副本");
  await fs.writeFile(path.join(projectRoot, ".notra", "plugin", "scripts", "notra-init.mjs"), "// 我的补丁", "utf8");

  const report = await runDoctor(projectRoot, root);
  const details = freshnessCheck(report).details as { staleCount: number; modifiedCount: number };

  assert.equal(details.staleCount, 1);
  assert.equal(details.modifiedCount, 1);
  assert.match(freshnessCheck(report).message, /1 个文件已过期/);
  assert.match(freshnessCheck(report).message, /1 个文件有本地修改/);
});

test("doctor only suggests commands that can actually resolve what it reported", async () => {
  const projectRoot = await createTempProject();
  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });

  // 用户改过的文件重装时会被保留，所以建议裸重装等于给一条无效命令，doctor 的 warn 永远消不掉
  await fs.writeFile(path.join(projectRoot, ".notra", "plugin", "scripts", "shared.mjs"), "// 我的补丁", "utf8");
  const edited = await runDoctor(projectRoot, root);

  assert.equal(edited.suggestions.includes("notra init --yes --platform-only"), false);
  assert.equal(edited.suggestions.includes("notra init --yes --platform-only --force"), true);

  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"], force: true });
  assert.equal(freshnessCheck(await runDoctor(projectRoot, root)).status, "pass");
});

test("doctor treats a never-installed runtime directory as stale", async () => {
  const projectRoot = await createTempProject();
  await installNotraPlatforms({ projectRoot, packageRoot: root, platforms: ["agents"] });
  await fs.rm(path.join(projectRoot, ".notra", "plugin", "dist"), { recursive: true });

  const check = freshnessCheck(await runDoctor(projectRoot, root));

  assert.equal(check.status, "warn");
  assert.equal((check.details as { staleFiles: string[] }).staleFiles.includes("dist/"), true);
});

function freshnessCheck(report: DoctorReport): DoctorCheck {
  const check = report.checks.find((item) => item.id === "runtime-freshness");
  assert.ok(check, "runtime-freshness check is missing");
  return check;
}

async function createTempProject(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "notra-doctor-test-"));
}
