import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyAdoptionSignals,
  extractRecommendedNodeIds
} from "../dist/core/session/adoption-signal.js";

function makeNodeMap(entries: Array<[string, string[]]>) {
  return new Map(entries.map(([id, paths]) => [id, { source_evidence: paths }]));
}

test("classifyAdoptionSignals: strong when agent adopted and evidence overlaps touched files", () => {
  const result = classifyAdoptionSignals({
    preflight: {
      mode: "knowledge-hit",
      matchedPractices: [{ recommended_option: "option-foo" }]
    },
    agentAdopted: ["option-foo"],
    agentNotApplicable: [],
    touchedFiles: ["src/api/foo.ts"],
    nodeMap: makeNodeMap([["option-foo", ["src/api/foo.ts"]]])
  });

  assert.deepEqual(result.strong, ["option-foo"]);
  assert.deepEqual(result.weak, []);
  assert.deepEqual(result.notApplicable, []);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].declared, "adopted");
  assert.equal(result.observations[0].signal, "strong");
  assert.equal(result.observations[0].evidence_overlap, true);
});

test("classifyAdoptionSignals: weak when agent adopted but no evidence overlap", () => {
  const result = classifyAdoptionSignals({
    preflight: {
      mode: "knowledge-hit",
      matchedPractices: [{ recommended_option: "option-foo" }]
    },
    agentAdopted: ["option-foo"],
    agentNotApplicable: [],
    touchedFiles: ["src/api/different.ts"],
    nodeMap: makeNodeMap([["option-foo", ["src/api/foo.ts"]]])
  });

  assert.deepEqual(result.strong, []);
  assert.deepEqual(result.weak, ["option-foo"]);
  assert.equal(result.observations[0].signal, "weak");
  assert.equal(result.observations[0].evidence_overlap, false);
});

test("classifyAdoptionSignals: weak when preflight hit but agent omitted classification", () => {
  const result = classifyAdoptionSignals({
    preflight: {
      mode: "knowledge-hit",
      matchedPractices: [{ recommended_option: "option-bar" }]
    },
    agentAdopted: [],
    agentNotApplicable: [],
    touchedFiles: ["src/api/bar.ts"],
    nodeMap: makeNodeMap([["option-bar", ["src/api/bar.ts"]]])
  });

  assert.deepEqual(result.strong, []);
  assert.deepEqual(result.weak, ["option-bar"]);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].declared, "missing");
  assert.equal(result.observations[0].signal, "weak");
});

test("classifyAdoptionSignals: notApplicable recorded but not scored", () => {
  const result = classifyAdoptionSignals({
    preflight: {
      mode: "knowledge-hit",
      matchedPractices: [{ recommended_option: "option-baz" }]
    },
    agentAdopted: [],
    agentNotApplicable: ["option-baz"],
    touchedFiles: ["src/api/other.ts"],
    nodeMap: makeNodeMap([["option-baz", ["src/api/baz.ts"]]])
  });

  assert.deepEqual(result.strong, []);
  assert.deepEqual(result.weak, []);
  assert.deepEqual(result.notApplicable, ["option-baz"]);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].declared, "not_applicable");
  assert.equal(result.observations[0].signal, "none");
  assert.equal(result.observations[0].evidence_overlap, null);
});

test("classifyAdoptionSignals: adopted takes precedence over notApplicable for the same node", () => {
  const result = classifyAdoptionSignals({
    preflight: {
      mode: "knowledge-hit",
      matchedPractices: [{ recommended_option: "option-foo" }]
    },
    agentAdopted: ["option-foo"],
    agentNotApplicable: ["option-foo"],
    touchedFiles: ["src/api/foo.ts"],
    nodeMap: makeNodeMap([["option-foo", ["src/api/foo.ts"]]])
  });

  assert.deepEqual(result.strong, ["option-foo"]);
  assert.deepEqual(result.notApplicable, []);
});

test("classifyAdoptionSignals: strong and weak coexist with observations for each", () => {
  const result = classifyAdoptionSignals({
    preflight: {
      mode: "knowledge-hit",
      matchedPractices: [
        { recommended_option: "option-foo" },
        { recommended_option: "option-bar" },
        { recommended_option: "option-baz" }
      ]
    },
    agentAdopted: ["option-foo"],
    agentNotApplicable: ["option-bar"],
    touchedFiles: ["src/api/foo.ts"],
    nodeMap: makeNodeMap([
      ["option-foo", ["src/api/foo.ts"]],
      ["option-bar", ["src/api/bar.ts"]],
      ["option-baz", ["src/api/baz.ts"]]
    ])
  });

  assert.deepEqual(result.strong, ["option-foo"]);
  assert.deepEqual(result.weak, ["option-baz"]);
  assert.deepEqual(result.notApplicable, ["option-bar"]);
  assert.equal(result.observations.length, 3);
});

test("extractRecommendedNodeIds returns empty when preflight did not hit knowledge", () => {
  assert.deepEqual(extractRecommendedNodeIds(null), []);
  assert.deepEqual(
    extractRecommendedNodeIds({ mode: "needs-project-scan", matchedPractices: [] }),
    []
  );
});

test("extractRecommendedNodeIds dedupes recommended options across practices", () => {
  const ids = extractRecommendedNodeIds({
    mode: "knowledge-hit",
    matchedPractices: [
      { recommended_option: "option-foo" },
      { recommended_option: "option-bar" },
      { recommended_option: "option-foo" }
    ]
  });
  assert.deepEqual(ids, ["option-foo", "option-bar"]);
});
