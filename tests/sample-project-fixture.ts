import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initializeProjectKnowledge } from "../dist/core/project/init.js";

const initFixtureRoot = path.resolve("tests", "fixtures", "init-sample-project");

export async function createInitializedSampleProject(prefix = "project-knowledge-sample-") {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const projectRoot = path.join(tempRoot, "sample-project");

  await fs.cp(initFixtureRoot, projectRoot, { recursive: true });
  await initializeProjectKnowledge(projectRoot);
  await seedSampleKnowledge(projectRoot);

  return projectRoot;
}

export async function createInitializedSampleKnowledge(prefix) {
  const projectRoot = await createInitializedSampleProject(prefix);
  return path.join(projectRoot, ".notra");
}

async function seedSampleKnowledge(projectRoot) {
  const knowledgeRoot = path.join(projectRoot, ".notra");
  const profilePath = path.join(knowledgeRoot, "project-profile.md");
  const profile = await fs.readFile(profilePath, "utf8");

  await fs.writeFile(
    profilePath,
    profile.replace("title: 示例初始化项目", "title: 示例项目"),
    "utf8"
  );
  await fs.writeFile(
    path.join(knowledgeRoot, "state", "usage-index.json"),
    `${JSON.stringify(
      {
        "option-unified-client": {
          session_mentions: 2,
          adopted_count: 1,
          last_used_at: "2026-04-23",
          last_session_id: "session-2026-04-23-sample"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(knowledgeRoot, "sessions", "session-2026-04-23-sample.md"),
    `---
id: session-2026-04-23-sample
type: session
title: 示例会话
date: "2026-04-23"
topic: http-client
decision_summary: 继续采用统一 HTTP client 方案。
touched_files: [src/api/client.ts]
adopted_nodes: [option-unified-client]
incubating_nodes: []
---

## Summary

继续采用统一 HTTP client 方案。
`,
    "utf8"
  );
}
