import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseFrontmatterBlock } from "../dist/core/knowledge/graph-model.js";
import { crystallizeSession } from "../dist/core/session/crystallize.js";
import { createInitializedSampleProject } from "./sample-project-fixture.ts";

test("frontmatter YAML serialize/parse round-trips through tricky strings", async () => {
  const projectRoot = await createInitializedSampleProject("yaml-roundtrip-");
  const sessionId = "session-2026-04-25-yaml-roundtrip";

  const tricky = {
    plainColon: "包含: 冒号",
    plainHash: "包含 # 井号",
    quotedDouble: 'foo "bar" baz',
    newline: "line1\nline2",
    leadingDash: "- 起始连字符",
    urlValue: "见 https://example.com:8080/path",
    yamlReserved: "true",
    backslash: "config\\\\nested\\\\path"
  };

  await crystallizeSession(projectRoot, {
    sessionId,
    topic: "yaml-roundtrip",
    title: tricky.quotedDouble,
    decisionSummary: tricky.urlValue,
    incubatingNodes: [
      {
        id: "practice-yaml-test",
        type: "practice",
        title: tricky.plainColon,
        summary: tricky.backslash,
        keywords: [tricky.plainHash, tricky.leadingDash, tricky.yamlReserved],
        source_evidence: []
      }
    ],
    writeSession: true
  });

  // 读 session markdown
  const sessionMd = await fs.readFile(
    path.join(projectRoot, ".notra", "sessions", `${sessionId}.md`),
    "utf8"
  );
  const sessionParsed = parseFrontmatterBlock(sessionMd).data as Record<string, unknown>;
  assert.equal(sessionParsed.title, tricky.quotedDouble, "title round-trip");
  assert.equal(sessionParsed.decision_summary, tricky.urlValue, "decision_summary round-trip");

  // 读 practice node markdown
  const practiceMd = await fs.readFile(
    path.join(projectRoot, ".notra", "incubating", "practices", "practice-yaml-test.md"),
    "utf8"
  );
  const practiceParsed = parseFrontmatterBlock(practiceMd).data as Record<string, unknown>;
  assert.equal(practiceParsed.title, tricky.plainColon, "node title round-trip");
  assert.equal(practiceParsed.summary, tricky.backslash, "backslash round-trip");
  assert.deepEqual(
    practiceParsed.keywords,
    [tricky.plainHash, tricky.leadingDash, tricky.yamlReserved],
    "array element round-trip"
  );

  await fs.rm(path.dirname(projectRoot), { recursive: true, force: true });
});

test("parseScalar unescapes double-quoted string content", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "yaml-parse-"));
  const sample = path.join(tmp, "sample.md");
  await fs.writeFile(
    sample,
    `---\ntitle: "foo \\"bar\\""\nsummary: "line1\\nline2"\nbackslash: "deep\\\\nested\\\\dir"\n---\nbody\n`,
    "utf8"
  );
  const parsed = parseFrontmatterBlock(await fs.readFile(sample, "utf8")).data as Record<string, string>;
  assert.equal(parsed.title, 'foo "bar"');
  assert.equal(parsed.summary, "line1\nline2");
  assert.equal(parsed.backslash, "deep\\nested\\dir");

  await fs.rm(tmp, { recursive: true, force: true });
});
