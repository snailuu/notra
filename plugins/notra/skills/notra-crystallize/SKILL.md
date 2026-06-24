---
name: notra-crystallize
description: Use when the user wants to persist a session or update project knowledge.
---

# Notra Crystallize

Treat this skill as the primary plugin entrypoint for manual crystallization.

## Required Behavior

- Determine the target project root from an explicit path; otherwise use the current working directory.
- Resolve `../../scripts/notra-crystallize.mjs` relative to this `SKILL.md` file.
- The wrapper delegates to `crystallize-session.mjs`.
- Prefer passing a JSON input file after the project path when adopted nodes, incubating nodes, touched files, stable updates, or user memory signals need to be recorded.
- **Adoption signal classification:** when the caller has knowledge of which preflight-recommended options were actually applied, populate BOTH:
  - `adopted`: option ids whose advice was followed in the produced code or decision.
  - `notApplicable`: option ids that were recommended but did not fit the task.
  - Manual `notra-crystallize` does NOT auto-run preflight; if `preflight` and `touchedFiles` are supplied alongside `adopted`/`notApplicable`, the script will additionally validate adopted ids by overlapping `source_evidence` with `touchedFiles` (overlap → strong, otherwise demoted to weak).
  - When the caller has no preflight context (e.g., a pure documentation crystallization), omit these fields; the script falls back to the legacy single-bucket behavior.
- Expect `log.md` and Obsidian `_views/` to be refreshed after crystallization.
- Report the result in Chinese and include whether this run only wrote a session or also updated incubating or stable knowledge, and the adopted/notApplicable classifications when present.

## JSON Input Shape

```json
{
  "sessionId": "session-YYYY-MM-DD-topic",
  "title": "本轮任务标题",
  "topic": "本轮任务主题",
  "decisionSummary": "一句话总结本轮关键决策。",
  "touchedFiles": [],
  "adopted": [],
  "notApplicable": [],
  "preflight": null,
  "incubatingNodes": [],
  "stableUpdates": [],
  "userMemory": {
    "kind": "intent-mismatch",
    "assistantSuggestion": "模型给用户提供的建议。",
    "userReply": "用户回复的实际问题或纠正方向。",
    "inferredPreference": "后续头脑风暴应参考的用户画像提示。",
    "confidence": 0.8
  }
}
```

- `adopted` / `notApplicable` are the new fields; the legacy `adoptedNodeIds` is still accepted as a synonym for `adopted`.
- `preflight` should be the raw object returned by `notra:notra-preflight` if available; without it the script skips the evidence overlap check.
