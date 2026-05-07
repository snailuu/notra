import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseFrontmatterBlock } from "../scripts/knowledge-lib.mjs";
import { createProjectKnowledgeServer } from "../scripts/serve-project-knowledge.mjs";
import { createInitializedSampleProject } from "./sample-project-fixture.mjs";

test("project knowledge server rejects a node through the governance API", async () => {
  const projectRoot = await copyProject("project-knowledge-api-reject-");
  const server = createProjectKnowledgeServer(projectRoot);
  const baseUrl = await listen(server);

  try {
    const governanceToken = await readGovernanceToken(baseUrl);
    const response = await fetch(`${baseUrl}/api/governance/reject`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-notra-governance-token": governanceToken
      },
      body: JSON.stringify({
        nodeId: "option-direct-call",
        reason: "manual-reject"
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.action.node_id, "option-direct-call");

    const document = await readFrontmatter(
      path.join(projectRoot, ".notra", "incubating", "options", "option-direct-call.md")
    );
    assert.equal(document.review_status, "rejected");
    assert.equal(document.rejected_reason, "manual-reject");
  } finally {
    await close(server);
  }
});

test("project knowledge server rejects invalid governance API node ids", async () => {
  const projectRoot = await copyProject("project-knowledge-api-invalid-");
  const server = createProjectKnowledgeServer(projectRoot);
  const baseUrl = await listen(server);

  try {
    const governanceToken = await readGovernanceToken(baseUrl);
    const response = await fetch(`${baseUrl}/api/governance/reject`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-notra-governance-token": governanceToken
      },
      body: JSON.stringify({
        nodeId: "../outside",
        reason: "bad"
      })
    });

    assert.equal(response.status, 400);
  } finally {
    await close(server);
  }
});

test("project knowledge server rejects governance writes without a valid token", async () => {
  const projectRoot = await copyProject("project-knowledge-api-token-");
  const server = createProjectKnowledgeServer(projectRoot);
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/governance/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: "option-direct-call",
        reason: "missing-token"
      })
    });

    assert.equal(response.status, 403);
  } finally {
    await close(server);
  }
});

test("project knowledge server rejects cross-origin governance writes", async () => {
  const projectRoot = await copyProject("project-knowledge-api-origin-");
  const server = createProjectKnowledgeServer(projectRoot);
  const baseUrl = await listen(server);

  try {
    const governanceToken = await readGovernanceToken(baseUrl);
    const response = await fetch(`${baseUrl}/api/governance/reject`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "origin": "http://example.test",
        "x-notra-governance-token": governanceToken
      },
      body: JSON.stringify({
        nodeId: "option-direct-call",
        reason: "bad-origin"
      })
    });

    assert.equal(response.status, 403);
  } finally {
    await close(server);
  }
});

test("project knowledge server limits governance request body size", async () => {
  const projectRoot = await copyProject("project-knowledge-api-large-body-");
  const server = createProjectKnowledgeServer(projectRoot);
  const baseUrl = await listen(server);

  try {
    const governanceToken = await readGovernanceToken(baseUrl);
    const response = await fetch(`${baseUrl}/api/governance/reject`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-notra-governance-token": governanceToken
      },
      body: JSON.stringify({
        nodeId: "option-direct-call",
        reason: "x".repeat(70 * 1024)
      })
    });

    assert.equal(response.status, 413);
  } finally {
    await close(server);
  }
});

async function copyProject(prefix) {
  return createInitializedSampleProject(prefix);
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function readGovernanceToken(baseUrl) {
  const response = await fetch(`${baseUrl}/api/governance/session`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.governanceToken, "string");
  return payload.governanceToken;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readFrontmatter(filePath) {
  const source = await fs.readFile(filePath, "utf8");
  return parseFrontmatterBlock(source).data;
}
