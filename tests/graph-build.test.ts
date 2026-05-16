import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildProjectGraphArtifacts } from "../dist/core/graph/build.js";
import { createInitializedSampleKnowledge } from "./sample-project-fixture.ts";

const fixtureRoot = await createInitializedSampleKnowledge("project-graph-build-fixture-");

test("buildProjectGraphArtifacts writes project graph data, index, and page assets", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "project-graph-build-"));
  const knowledgeRoot = path.join(tempRoot, ".notra");

  await fs.cp(fixtureRoot, knowledgeRoot, { recursive: true });

  const result = await buildProjectGraphArtifacts(knowledgeRoot);
  const graphData = JSON.parse(
    await fs.readFile(path.join(knowledgeRoot, "graph", "graph-data.json"), "utf8")
  );

  assert.ok(result.graph.nodes.length > 0);
  assert.ok(result.index.project_views.length > 0);
  assert.equal(
    await fileExists(path.join(knowledgeRoot, "graph", "knowledge-graph.html")),
    true
  );
  assert.equal(graphData.stats.counts_by_maturity.stable, 8);
  assert.equal(graphData.stats.counts_by_maturity.incubating, 1);
});

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
