import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildProjectGraphFromDirectory, computeDaysSince, LIFECYCLE_POLICY } from "../dist/core/knowledge/graph-model.js";
import { governProjectKnowledge } from "../dist/core/governance/govern.js";
import { lintProjectKnowledge } from "../dist/core/governance/lint.js";
import { createInitializedSampleProject } from "./sample-project-fixture.ts";

test("computeDaysSince returns Infinity for nullish or invalid date strings", () => {
  assert.equal(computeDaysSince(null), Infinity);
  assert.equal(computeDaysSince(undefined as any), Infinity);
  assert.equal(computeDaysSince(""), Infinity);
  assert.equal(computeDaysSince("not-a-date"), Infinity);
});

test("computeDaysSince counts whole days between dates", () => {
  const now = new Date("2026-06-23T00:00:00Z");
  assert.equal(computeDaysSince("2026-06-22", now), 1);
  assert.equal(computeDaysSince("2026-06-23", now), 0);
  assert.equal(computeDaysSince("2026-03-25", now), 90);
  assert.equal(computeDaysSince("2026-03-24", now), 91);
});

test("stable node older than coldStorageDays becomes cold-storage-candidate", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-cold-mark-");
  const knowledgeRoot = path.join(projectRoot, ".notra");

  // 让 option-unified-client 的 last_used_at 远超阈值
  const oldDate = "2025-01-01";
  const usagePath = path.join(knowledgeRoot, "state", "usage-index.json");
  const usage = JSON.parse(await fs.readFile(usagePath, "utf8"));
  usage["option-unified-client"].last_used_at = oldDate;
  await fs.writeFile(usagePath, `${JSON.stringify(usage, null, 2)}\n`, "utf8");

  const graph = await buildProjectGraphFromDirectory(knowledgeRoot) as any;
  const node = graph.nodes.find((n: any) => n.id === "option-unified-client");
  assert.equal(node.maturity, "stable");
  assert.equal(node.lifecycle_state, "cold-storage-candidate");
  assert.ok(node.lifecycle_reasons.includes("cold-storage"));
});

test("incubating node with no last_used_at is NOT marked cold-storage", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-cold-incubating-");
  const knowledgeRoot = path.join(projectRoot, ".notra");

  // 创建一个孵化节点
  const incubatingPath = path.join(knowledgeRoot, "incubating", "options", "option-incub-no-cold.md");
  await fs.mkdir(path.dirname(incubatingPath), { recursive: true });
  await fs.writeFile(
    incubatingPath,
    `---
id: option-incub-no-cold
type: option
title: 孵化节点不应冷藏
summary: 孵化路径上不触发冷藏。
practice: practice-http-client
maturity: incubating
base_score: 70
source_evidence:
  - src/api/incub.ts
---

## Summary

孵化节点不应触发冷藏。
`,
    "utf8"
  );

  const graph = await buildProjectGraphFromDirectory(knowledgeRoot) as any;
  const node = graph.nodes.find((n: any) => n.id === "option-incub-no-cold");
  assert.equal(node.maturity, "incubating");
  assert.notEqual(node.lifecycle_state, "cold-storage-candidate");
});

test("lint reports node-cold-storage-candidate when threshold exceeded", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-cold-lint-");
  const knowledgeRoot = path.join(projectRoot, ".notra");

  const usagePath = path.join(knowledgeRoot, "state", "usage-index.json");
  const usage = JSON.parse(await fs.readFile(usagePath, "utf8"));
  usage["option-unified-client"].last_used_at = "2025-01-01";
  await fs.writeFile(usagePath, `${JSON.stringify(usage, null, 2)}\n`, "utf8");

  const report = await lintProjectKnowledge(projectRoot);
  const issue = report.issues.find((i: any) => i.code === "node-cold-storage-candidate" && i.node_id === "option-unified-client");
  assert.ok(issue, "应当报告 cold-storage-candidate");
  assert.equal((issue as any).cold_storage_days, LIFECYCLE_POLICY.coldStorageDays);
  assert.equal(typeof (issue as any).days_since_last_used, "number");
});

test("govern dry-run reports cold-storage-demote without moving files", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-cold-dryrun-");
  const knowledgeRoot = path.join(projectRoot, ".notra");

  const usagePath = path.join(knowledgeRoot, "state", "usage-index.json");
  const usage = JSON.parse(await fs.readFile(usagePath, "utf8"));
  usage["option-unified-client"].last_used_at = "2025-01-01";
  await fs.writeFile(usagePath, `${JSON.stringify(usage, null, 2)}\n`, "utf8");

  const beforeStable = await fs.readFile(path.join(knowledgeRoot, "options", "option-unified-client.md"), "utf8");

  const result = await governProjectKnowledge(projectRoot, { dryRun: true });
  const demoteAction = result.actions.find((a: any) => a.type === "cold-storage-demote" && a.node_id === "option-unified-client");
  assert.ok(demoteAction);
  assert.equal((demoteAction as any).dry_run, true);

  // 文件未被移动
  const stillStable = await fs.readFile(path.join(knowledgeRoot, "options", "option-unified-client.md"), "utf8").catch(() => null);
  assert.equal(stillStable, beforeStable);
  const incubatingPath = path.join(knowledgeRoot, "incubating", "options", "option-unified-client.md");
  const incubatingExists = await fs.access(incubatingPath).then(() => true).catch(() => false);
  assert.equal(incubatingExists, false);
});

test("govern physically demotes cold-storage stable to incubating and writes lifecycle_history", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-cold-demote-");
  const knowledgeRoot = path.join(projectRoot, ".notra");

  const usagePath = path.join(knowledgeRoot, "state", "usage-index.json");
  const usage = JSON.parse(await fs.readFile(usagePath, "utf8"));
  usage["option-unified-client"].last_used_at = "2025-01-01";
  await fs.writeFile(usagePath, `${JSON.stringify(usage, null, 2)}\n`, "utf8");

  const result = await governProjectKnowledge(projectRoot);
  const demoteAction = result.actions.find((a: any) => a.type === "cold-storage-demote" && a.node_id === "option-unified-client");
  assert.ok(demoteAction);

  const oldStable = await fs.access(path.join(knowledgeRoot, "options", "option-unified-client.md")).then(() => true).catch(() => false);
  assert.equal(oldStable, false, "原 stable 文件应被删除");
  const newIncubating = await fs.readFile(path.join(knowledgeRoot, "incubating", "options", "option-unified-client.md"), "utf8");
  assert.match(newIncubating, /maturity: incubating/);
  assert.match(newIncubating, /lifecycle_history:/);
  // 历史条目以 JSON 字符串形式存储；YAML render 会对引号转义
  assert.match(newIncubating, /\\"from\\":\\"stable\\"/);
  assert.match(newIncubating, /\\"reason\\":\\"cold-storage\\"/);
  // 再次跑 graph build 时 lifecycle_history 字段应被 normalizeNode 读出
  const graph = await buildProjectGraphFromDirectory(knowledgeRoot) as any;
  const node = graph.nodes.find((n: any) => n.id === "option-unified-client");
  assert.equal(node.maturity, "incubating");
  assert.equal(node.lifecycle_history.length, 1);
  const parsed = JSON.parse(node.lifecycle_history[0]);
  assert.equal(parsed.from, "stable");
  assert.equal(parsed.to, "incubating");
  assert.equal(parsed.reason, "cold-storage");
});
