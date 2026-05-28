import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { crystallizeSession } from "../dist/core/session/crystallize.js";
import { createInitializedSampleProject } from "./sample-project-fixture.ts";

const execFileAsync = promisify(execFile);

test("crystallizeSession supports no-op, session-only, incubating, and stable-update flows", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-crystallize-");

  const noOp = await crystallizeSession(projectRoot, {
    writeSession: false,
    topic: "noop"
  });
  assert.equal(noOp.mode, "no-op");

  const sessionOnly = await crystallizeSession(projectRoot, {
    sessionId: "session-2026-04-23-session-only",
    title: "只写会话",
    topic: "session-only",
    decisionSummary: "本轮没有形成稳定知识。",
    touchedFiles: ["src/pages/demo.ts"]
  });
  assert.equal(sessionOnly.mode, "session-only");
  assert.equal(
    await fileExists(
      path.join(
        projectRoot,
        ".notra",
        "sessions",
        "session-2026-04-23-session-only.md"
      )
    ),
    true
  );

  const incubating = await crystallizeSession(projectRoot, {
    sessionId: "session-2026-04-23-incubating",
    title: "新增孵化知识",
    topic: "incubating",
    decisionSummary: "发现一个可复用但尚未稳定的新方案。",
    touchedFiles: ["src/pages/demo.ts"],
    incubatingNodes: [
      {
        id: "option-shared-status-layer",
        type: "option",
        title: "共享任务状态层",
        summary: "把局部状态更新收敛到共享状态层。",
        practice: "practice-http-client",
        base_score: 44,
        score_breakdown: {
          consistency: 9,
          efficiency: 9,
          maintainability: 9,
          extensibility: 9,
          risk: 8
        },
        keywords: ["status"],
        source_evidence: ["src/pages/demo.ts"]
      }
    ]
  });
  assert.equal(incubating.mode, "session+incubating");
  assert.equal(
    await fileExists(
      path.join(
        projectRoot,
        ".notra",
        "incubating",
        "options",
        "option-shared-status-layer.md"
      )
    ),
    true
  );

  const stableUpdate = await crystallizeSession(projectRoot, {
    sessionId: "session-2026-04-23-stable-update",
    title: "更新稳定知识",
    topic: "stable-update",
    decisionSummary: "再次确认统一 client 是默认做法。",
    touchedFiles: ["src/api/client.ts", "docs/engineering.md"],
    adoptedNodeIds: ["option-unified-client"],
    stableUpdates: [
      {
        id: "rule-use-unified-client",
        type: "rule",
        summary: "默认通过统一 client 发起远程调用，页面层不应直接内联公共请求治理逻辑。"
      }
    ]
  });
  assert.equal(stableUpdate.mode, "session+stable-update");

  const updatedRule = await fs.readFile(
    path.join(
      projectRoot,
      ".notra",
      "rules",
      "rule-use-unified-client.md"
    ),
    "utf8"
  );
  const usageIndex = JSON.parse(
    await fs.readFile(
      path.join(projectRoot, ".notra", "state", "usage-index.json"),
      "utf8"
    )
  );

  assert.match(updatedRule, /页面层不应直接内联公共请求治理逻辑/);
  assert.equal(usageIndex["option-unified-client"].adopted_count, 2);
});

test("crystallize CLI accepts a JSON input file for adopted and incubating updates", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-crystallize-cli-");
  const inputPath = path.join(path.dirname(projectRoot), "crystallize-input.json");
  await fs.writeFile(
    inputPath,
    `${JSON.stringify(
      {
        sessionId: "session-2026-04-23-cli-json",
        title: "CLI JSON 结晶",
        topic: "cli-json",
        decisionSummary: "通过 CLI JSON 记录采纳和新增孵化实践。",
        touchedFiles: ["src/pages/demo.ts"],
        adoptedNodeIds: ["option-unified-client"],
        incubatingNodes: [
          {
            id: "option-cli-json-status-layer",
            type: "option",
            title: "CLI JSON 状态层",
            summary: "通过 CLI JSON 写入的状态层候选。",
            practice: "practice-http-client",
            base_score: 45,
            score_breakdown: {
              consistency: 9,
              efficiency: 9,
              maintainability: 9,
              extensibility: 9,
              risk: 9
            },
            keywords: ["status"],
            source_evidence: ["src/pages/demo.ts"]
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve("plugins", "notra", "scripts", "notra-crystallize.mjs"),
    projectRoot,
    inputPath
  ]);
  const result = JSON.parse(stdout);

  assert.equal(result.mode, "session+incubating");
  assert.deepEqual(result.adoptedNodeIds, ["option-unified-client"]);
  assert.deepEqual(result.incubatingNodeIds, ["option-cli-json-status-layer"]);
  assert.equal(
    await fileExists(
      path.join(
        projectRoot,
        ".notra",
        "incubating",
        "options",
        "option-cli-json-status-layer.md"
      )
    ),
    true
  );

  const usageIndex = JSON.parse(
    await fs.readFile(
      path.join(projectRoot, ".notra", "state", "usage-index.json"),
      "utf8"
    )
  );
  const log = await fs.readFile(
    path.join(projectRoot, ".notra", "log.md"),
    "utf8"
  );
  const incubatingView = await fs.readFile(
    path.join(projectRoot, ".notra", "_views", "incubating.md"),
    "utf8"
  );

  assert.equal(usageIndex["option-unified-client"].adopted_count, 2);
  assert.match(log, /notra:crystallize/);
  assert.match(log, /session-2026-04-23-cli-json/);
  assert.match(incubatingView, /\[\[option-cli-json-status-layer\]\]/);
});

test("crystallizeSession records user profile memory from reflection signals", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-user-memory-");

  const result = await crystallizeSession(projectRoot, {
    sessionId: "session-2026-04-24-user-memory",
    title: "记录用户画像",
    topic: "user-memory",
    decisionSummary: "用户纠正了模型建议方向，需要形成后续头脑风暴提示。",
    userMemory: {
      kind: "intent-mismatch",
      assistantSuggestion: "先补充产品功能描述。",
      userReply: "先把测试文件从 mjs 迁移到 ts。",
      inferredPreference: "用户倾向先完成可验证的工程阶段，再讨论功能包装。",
      confidence: 0.8
    }
  });

  assert.equal(result.mode, "session+user-memory");
  assert.deepEqual(result.userMemoryIds, [
    "session-2026-04-24-user-memory-user-memory-intent-mismatch-1"
  ]);

  const memory = JSON.parse(
    await fs.readFile(path.join(projectRoot, ".notra", "state", "user-memory.json"), "utf8")
  );
  assert.equal(memory.memories.length, 1);
  assert.equal(memory.memories[0].kind, "intent-mismatch");
  assert.equal(
    memory.memories[0].inferred_preference,
    "用户倾向先完成可验证的工程阶段，再讨论功能包装。"
  );

  const session = await fs.readFile(
    path.join(projectRoot, ".notra", "sessions", "session-2026-04-24-user-memory.md"),
    "utf8"
  );
  assert.match(session, /user_memory_ids:/);
  assert.match(session, /用户倾向先完成可验证的工程阶段/);
});

test("crystallizeSession bounds and redacts user profile memory", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-user-memory-bounds-");
  const knowledgeRoot = path.join(projectRoot, ".notra");
  const oldMemories = Array.from({ length: 55 }, (_, index) => ({
    id: `old-${index}`,
    session_id: `session-old-${index}`,
    kind: "intent-mismatch",
    inferred_preference: `旧画像 ${index}`,
    confidence: 0.5,
    created_at: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
  }));
  await fs.writeFile(
    path.join(knowledgeRoot, "state", "user-memory.json"),
    `${JSON.stringify({ updated_at: "2026-01-01T00:00:00.000Z", memories: oldMemories }, null, 2)}\n`,
    "utf8"
  );

  const result = await crystallizeSession(projectRoot, {
    sessionId: "session-2026-04-24-user-memory-bounds",
    title: "限制用户画像",
    topic: "user-memory-bounds",
    userMemories: Array.from({ length: 6 }, (_, index) => ({
      kind: `intent-mismatch-${index}`,
      assistantSuggestion: index === 0 ? "token=super-secret-value-1234567890" : `建议 ${index}`,
      userReply: "  用户   回应  ",
      inferredPreference: `${"偏好".repeat(400)} ${index}`,
      confidence: 2
    }))
  });

  const memory = JSON.parse(
    await fs.readFile(path.join(knowledgeRoot, "state", "user-memory.json"), "utf8")
  );
  const newMemories = memory.memories.filter((item) => item.session_id === result.sessionId);

  assert.equal(result.userMemoryIds.length, 5);
  assert.equal(memory.memories.length, 50);
  assert.equal(newMemories.length, 5);
  assert.equal(newMemories[0].assistant_suggestion, "[REDACTED]");
  assert.equal(newMemories[0].user_reply, "用户 回应");
  assert.equal(newMemories[0].confidence, 1);
  assert.ok(newMemories[0].inferred_preference.length <= 500);
  assert.equal(memory.memories.some((item) => item.id === "old-0"), false);

  const session = await fs.readFile(
    path.join(knowledgeRoot, "sessions", "session-2026-04-24-user-memory-bounds.md"),
    "utf8"
  );
  assert.match(session, /\[REDACTED\]/);
  assert.doesNotMatch(session, /super-secret-value/);
});

test("crystallizeSession recovers stale user memory locks", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-user-memory-stale-lock-");
  const knowledgeRoot = path.join(projectRoot, ".notra");
  const lockPath = path.join(knowledgeRoot, "state", ".user-memory.lock");
  await fs.mkdir(lockPath, { recursive: true });
  const staleTime = new Date(Date.now() - 60000);
  await fs.utimes(lockPath, staleTime, staleTime);

  const result = await crystallizeSession(projectRoot, {
    sessionId: "session-2026-04-24-user-memory-stale-lock",
    title: "恢复陈旧锁",
    topic: "user-memory-stale-lock",
    userMemory: {
      kind: "intent-mismatch",
      inferredPreference: "陈旧锁不应阻塞后续画像写入。"
    }
  });

  const memory = JSON.parse(
    await fs.readFile(path.join(knowledgeRoot, "state", "user-memory.json"), "utf8")
  );
  assert.equal(result.mode, "session+user-memory");
  assert.equal(memory.memories.some((item) => item.session_id === result.sessionId), true);
  assert.equal(await fileExists(lockPath), false);
});

test("crystallizeSession preserves concurrent user memory writes", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-user-memory-concurrent-");

  await Promise.all([
    crystallizeSession(projectRoot, {
      sessionId: "session-2026-04-24-user-memory-concurrent-a",
      title: "并发画像 A",
      topic: "user-memory-concurrent-a",
      userMemory: { kind: "intent-mismatch", inferredPreference: "并发画像 A" }
    }),
    crystallizeSession(projectRoot, {
      sessionId: "session-2026-04-24-user-memory-concurrent-b",
      title: "并发画像 B",
      topic: "user-memory-concurrent-b",
      userMemory: { kind: "intent-mismatch", inferredPreference: "并发画像 B" }
    })
  ]);

  const memory = JSON.parse(
    await fs.readFile(path.join(projectRoot, ".notra", "state", "user-memory.json"), "utf8")
  );
  assert.equal(memory.memories.some((item) => item.inferred_preference === "并发画像 A"), true);
  assert.equal(memory.memories.some((item) => item.inferred_preference === "并发画像 B"), true);
});

test("plugin crystallize runtime records user profile memory", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-plugin-user-memory-");
  const inputPath = path.join(path.dirname(projectRoot), "plugin-user-memory.json");
  await fs.writeFile(
    inputPath,
    `${JSON.stringify(
      {
        sessionId: "session-2026-04-24-plugin-user-memory",
        title: "插件记录用户画像",
        topic: "plugin-user-memory",
        decisionSummary: "插件入口也应记录用户画像。",
        userMemory: {
          kind: "intent-mismatch",
          assistantSuggestion: "先扩展功能描述。",
          userReply: "先修复运行时一致性。",
          inferredPreference: "用户会优先要求插件和 CLI 行为保持一致。",
          confidence: 0.85
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve("plugins", "notra", "scripts", "notra-crystallize.mjs"),
    projectRoot,
    inputPath
  ]);
  const result = JSON.parse(stdout);
  const memory = JSON.parse(
    await fs.readFile(path.join(projectRoot, ".notra", "state", "user-memory.json"), "utf8")
  );

  assert.equal(result.mode, "session+user-memory");
  assert.equal(memory.memories[0].inferred_preference, "用户会优先要求插件和 CLI 行为保持一致。");
});

test("crystallizeSession rejects unsafe ids and node types before writing files", async () => {
  const projectRoot = await createInitializedSampleProject("project-knowledge-crystallize-invalid-");

  await assert.rejects(
    crystallizeSession(projectRoot, {
      sessionId: "../outside",
      topic: "invalid-session"
    }),
    /非法 sessionId/
  );

  await assert.rejects(
    crystallizeSession(projectRoot, {
      sessionId: "session-2026-04-23-invalid-node",
      incubatingNodes: [
        {
          id: "../outside",
          type: "option",
          title: "非法节点",
          summary: "不应写入知识库外部。",
          practice: "practice-http-client"
        }
      ]
    }),
    /非法 nodeId/
  );

  await assert.rejects(
    crystallizeSession(projectRoot, {
      sessionId: "session-2026-04-23-invalid-type",
      incubatingNodes: [
        {
          id: "option-invalid-type",
          type: "../options",
          title: "非法类型",
          summary: "不应写入知识库外部。",
          practice: "practice-http-client"
        }
      ]
    }),
    /非法节点类型/
  );
});

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
