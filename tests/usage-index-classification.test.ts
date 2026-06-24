import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { crystallizeSession } from "../dist/core/session/crystallize.js";
import { buildProjectGraphFromDirectory } from "../dist/core/knowledge/graph-model.js";
import { createInitializedSampleProject } from "./sample-project-fixture.ts";

test("weak signals never advance an incubating node toward promotion", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-weak-only-");
  const knowledgeRoot = path.join(projectRoot, ".notra");

  // 注入一个孵化节点
  const incubatingPath = path.join(knowledgeRoot, "incubating", "options", "option-weak-only.md");
  await fs.mkdir(path.dirname(incubatingPath), { recursive: true });
  await fs.writeFile(
    incubatingPath,
    `---
id: option-weak-only
type: option
title: 仅 weak 信号孵化方案
summary: 用来验证仅 weak 信号不应推动晋升。
practice: practice-http-client
maturity: incubating
base_score: 80
source_evidence:
  - src/api/never-touched.ts
---

## Summary

仅作 weak 信号单元测试用。
`,
    "utf8"
  );

  // 直接写 usage-index：weak_count 高、strong_count = 0
  const usagePath = path.join(knowledgeRoot, "state", "usage-index.json");
  const currentUsage = JSON.parse(await fs.readFile(usagePath, "utf8"));
  currentUsage["option-weak-only"] = {
    session_mentions: 10,
    adopted_count: 0,
    strong_count: 0,
    weak_count: 10,
    not_applicable_count: 0,
    last_used_at: null,
    last_session_id: null
  };
  await fs.writeFile(usagePath, `${JSON.stringify(currentUsage, null, 2)}\n`, "utf8");

  const graph = await buildProjectGraphFromDirectory(knowledgeRoot) as any;
  const node = graph.nodes.find((n: any) => n.id === "option-weak-only");

  assert.ok(node, "incubating node 必须能被加载");
  assert.equal(node.maturity, "incubating");
  assert.notEqual(node.lifecycle_state, "promotion_candidate");
  assert.equal(node.usage_stats.strong_count, 0);
  assert.equal(node.usage_stats.weak_count, 10);
});

test("crystallize without preflight falls back to legacy single-bucket: adopted → strong", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-fallback-");
  const knowledgeRoot = path.join(projectRoot, ".notra");

  // 老调用：只传 adopted 字段，不传 preflight/touchedFiles，期望保持向后兼容（adopted 全 strong）
  await crystallizeSession(projectRoot, {
    sessionId: "session-2026-06-23-fallback",
    title: "fallback test",
    topic: "fallback",
    decisionSummary: "no preflight 兜底路径",
    adopted: ["option-unified-client"],
    incubatingNodes: [],
    stableUpdates: []
  });

  const usage = JSON.parse(await fs.readFile(path.join(knowledgeRoot, "state", "usage-index.json"), "utf8"));
  // fixture 起始 adopted_count=1，本轮 +1 → 2（strong_count 同步）
  assert.equal(usage["option-unified-client"].adopted_count, 2);
  assert.equal(usage["option-unified-client"].strong_count, 2);
});

test("crystallize with preflight + touched evidence: adopted demotes to weak on no overlap", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-evidence-miss-");
  const knowledgeRoot = path.join(projectRoot, ".notra");

  // 模拟 preflight 输出 + adopted 声明 + touched 不命中
  await crystallizeSession(projectRoot, {
    sessionId: "session-2026-06-23-miss",
    title: "evidence miss",
    topic: "evidence-miss",
    decisionSummary: "声明 adopted 但 touchedFiles 与 source_evidence 不交集，应降为 weak",
    touchedFiles: ["src/totally/unrelated.ts"],
    adopted: ["option-unified-client"],
    preflight: {
      mode: "knowledge-hit",
      matchedPractices: [{ recommended_option: "option-unified-client" }]
    }
  });

  const usage = JSON.parse(await fs.readFile(path.join(knowledgeRoot, "state", "usage-index.json"), "utf8"));
  // 起始 adopted=1, weak=2；本轮 weak +1 → weak=3，strong/adopted 保持 1
  assert.equal(usage["option-unified-client"].adopted_count, 1);
  assert.equal(usage["option-unified-client"].strong_count, 1);
  assert.equal(usage["option-unified-client"].weak_count, 3);

  const observationsLogPath = path.join(knowledgeRoot, "state", "adoption_observations.jsonl");
  const log = await fs.readFile(observationsLogPath, "utf8");
  const lines = log.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].declared, "adopted");
  assert.equal(lines[0].signal, "weak");
  assert.equal(lines[0].evidence_overlap, false);
});

test("crystallize records notApplicable observations without scoring", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-na-");
  const knowledgeRoot = path.join(projectRoot, ".notra");

  await crystallizeSession(projectRoot, {
    sessionId: "session-2026-06-23-na",
    title: "not applicable test",
    topic: "na",
    decisionSummary: "agent 明示 notApplicable",
    touchedFiles: ["src/api/client.ts"],
    adopted: [],
    notApplicable: ["option-unified-client"],
    preflight: {
      mode: "knowledge-hit",
      matchedPractices: [{ recommended_option: "option-unified-client" }]
    }
  });

  const usage = JSON.parse(await fs.readFile(path.join(knowledgeRoot, "state", "usage-index.json"), "utf8"));
  // not_applicable_count 累计，strong/weak 保持原值（起始 adopted=1, weak=2）
  assert.equal(usage["option-unified-client"].not_applicable_count, 1);
  assert.equal(usage["option-unified-client"].adopted_count, 1);
  assert.equal(usage["option-unified-client"].weak_count, 2);

  const log = await fs.readFile(path.join(knowledgeRoot, "state", "adoption_observations.jsonl"), "utf8");
  const lines = log.trim().split("\n").map((line) => JSON.parse(line));
  // 只有一条 notApplicable 观测，且推荐节点既不在 adopted 也不在 notApplicable 之外
  assert.equal(lines.length, 1);
  assert.equal(lines[0].declared, "not_applicable");
  assert.equal(lines[0].signal, "none");
});

test("legacy usage-index entries without strong_count are lazy-migrated", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-lazy-");
  const knowledgeRoot = path.join(projectRoot, ".notra");

  // 老 fixture 缺 strong_count/weak_count
  const usagePath = path.join(knowledgeRoot, "state", "usage-index.json");
  await fs.writeFile(
    usagePath,
    `${JSON.stringify(
      {
        "option-unified-client": {
          session_mentions: 2,
          adopted_count: 4,
          last_used_at: "2026-04-23",
          last_session_id: "session-legacy"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const graph = await buildProjectGraphFromDirectory(knowledgeRoot) as any;
  const node = graph.nodes.find((n: any) => n.id === "option-unified-client");
  // lazy 迁移：strong_count 缺失 → 用 adopted_count 兜底
  assert.equal(node.usage_stats.strong_count, 4);
  assert.equal(node.usage_stats.weak_count, 0);
  assert.equal(node.usage_stats.not_applicable_count, 0);
});

test("adoption_observations.jsonl appends well-formed JSON lines", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-jsonl-");
  const knowledgeRoot = path.join(projectRoot, ".notra");

  await crystallizeSession(projectRoot, {
    sessionId: "session-2026-06-23-jsonl-1",
    title: "jsonl test 1",
    topic: "jsonl",
    touchedFiles: ["src/api/client.ts"],
    adopted: ["option-unified-client"],
    preflight: {
      mode: "knowledge-hit",
      matchedPractices: [{ recommended_option: "option-unified-client" }]
    }
  });
  await crystallizeSession(projectRoot, {
    sessionId: "session-2026-06-23-jsonl-2",
    title: "jsonl test 2",
    topic: "jsonl",
    touchedFiles: ["src/api/client.ts"],
    adopted: ["option-unified-client"],
    preflight: {
      mode: "knowledge-hit",
      matchedPractices: [{ recommended_option: "option-unified-client" }]
    }
  });

  const log = await fs.readFile(path.join(knowledgeRoot, "state", "adoption_observations.jsonl"), "utf8");
  const lines = log.trim().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.ok(parsed.ts, "ts 字段必须存在");
    assert.ok(parsed.session_id, "session_id 字段必须存在");
    assert.equal(typeof parsed.touched_files_count, "number");
    assert.ok(["strong", "weak", "none"].includes(parsed.signal));
  }
});
