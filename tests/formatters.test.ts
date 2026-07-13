import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildFinishNextSteps, formatInitSummary } from "../dist/cli/formatters.js";

test("buildFinishNextSteps hands agents a command that never waits for input", () => {
  const steps = buildFinishNextSteps({ mode: "no-knowledge" } as any, null, null);

  // 裸 notra init 在 TTY 下会停在平台多选，agent 逐字执行会挂住
  assert.deepEqual(steps, ["notra init --yes"]);
});

test("buildFinishNextSteps suggests lint and graph only when they are needed", () => {
  const clean = buildFinishNextSteps(
    { mode: "crystallized" } as any,
    { summary: { issue_count: 0 } } as any,
    { graphDirty: false } as any
  );
  assert.deepEqual(clean, ["notra status"]);

  const dirty = buildFinishNextSteps(
    { mode: "crystallized" } as any,
    { summary: { issue_count: 2 } } as any,
    { graphDirty: true } as any
  );
  assert.deepEqual(dirty, ["notra lint", "notra graph", "notra status"]);
});

test("formatInitSummary separates runtime refresh, skill refresh, and preserved edits", () => {
  const summary = formatInitSummary({
    projectRoot: "/tmp/proj",
    platformInstall: {
      platforms: ["agents"],
      dryRun: false,
      writes: [
        { path: "/tmp/proj/.notra/plugin/scripts/shared.mjs", action: "overwrite", scope: "runtime" },
        { path: "/tmp/proj/.notra/plugin/scripts/new.mjs", action: "create", scope: "runtime" },
        { path: "/tmp/proj/.agents/skills/notra-init/SKILL.md", action: "overwrite", scope: "skill" }
      ],
      skipped: [
        { path: "/tmp/proj/.agents/skills/notra-lint/SKILL.md", reason: "diverged", scope: "skill" },
        { path: "/tmp/proj/.notra/plugin/scripts/other.mjs", reason: "unchanged", scope: "runtime" }
      ]
    } as any,
    projectKnowledge: null,
    nextSteps: ["notra status"]
  });

  assert.match(summary, /刷新运行时: 1 个文件/);
  assert.match(summary, /刷新 skill: 1 个文件/);
  assert.match(summary, /保留本地改动: 1 个文件/);
  // 被覆盖的 skill 绝不能被算进「刷新运行时」——那是本次修复的核心
  assert.doesNotMatch(summary, /刷新运行时: 2 个文件/);
  assert.match(summary.replaceAll(path.sep, "/"), /- \.agents\/skills\/notra-lint\/SKILL\.md/);
});
