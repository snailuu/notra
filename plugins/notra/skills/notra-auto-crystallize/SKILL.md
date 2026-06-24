---
name: notra-auto-crystallize
description: Use when the user wants task-end project knowledge crystallization to be inferred from the current task, touched files, and existing recommendation matches.
---

# Notra Auto Crystallize

Treat this skill as the preferred task-end entrypoint when the user wants the project knowledge loop to update with minimal manual JSON authoring.

## Required Behavior

- Determine the target project root from an explicit path; otherwise use the current working directory.
- Resolve `../../scripts/notra-auto-crystallize.mjs` relative to this `SKILL.md` file.
- The wrapper delegates to `auto-crystallize-session.mjs`.
- If `.notra/project-profile.md` is missing, return `mode: no-knowledge` and skip crystallization entirely; do not scan touched files, create sessions, or create `.notra/`.
- Prefer passing a JSON input file after the project path when the task summary, touched files, or session id are known.
- **Adoption signal classification (REQUIRED for every preflight-recommended option):**
  - At task start you call `notra:notra-preflight` and receive `matchedPractices[].recommended_option` ids — remember them.
  - At task end, for EACH recommended option, classify it into ONE of:
    - `adopted`: you actually applied this option in this task. The script will additionally check that at least one of the node's `source_evidence` paths overlaps with `touchedFiles`. Overlap → **strong** signal (counts toward promotion); no overlap → demoted to **weak**.
    - `notApplicable`: this option did not fit the task context (e.g., wrong layer, wrong domain). Recorded for observation but does NOT count as adoption or rejection.
  - A recommended option that appears in NEITHER `adopted` NOR `notApplicable` is silently recorded as **weak** evidence (you forgot to classify it). This will not break crystallization but will not advance the option toward promotion either.
  - Do NOT default options to `adopted` — only include options whose application you can point to in code. When in doubt, prefer `notApplicable` over `adopted`.
- If `incubatingNodes` is omitted and no practice matches, allow the script to create an incubating practice plus candidate option from `taskText` and `touchedFiles`.
- Report the result in Chinese and include `mode`, classified adopted/notApplicable nodes, generated incubating nodes, touched files, and the next suggested skill `notra:notra-lint`; when skipped because knowledge is uninitialized, suggest `notra:notra-init` instead.

## JSON Input Shape

```json
{
  "sessionId": "session-YYYY-MM-DD-topic",
  "title": "本轮任务标题",
  "topic": "本轮任务主题",
  "taskText": "用于匹配已有实践的任务描述",
  "decisionSummary": "一句话总结本轮关键决策。",
  "touchedFiles": [],
  "adopted": [],
  "notApplicable": [],
  "incubatingNodes": [],
  "stableUpdates": []
}
```

- `touchedFiles` may be omitted; the script falls back to `git status --porcelain` and `git diff --name-only` to collect file paths.
- `adopted` / `notApplicable` are the new fields; the legacy `adoptedNodeIds` field is still accepted as a synonym for `adopted` to keep older callers working, but new SKILL invocations should use the explicit pair.
- The script invokes `notra:notra-preflight` internally; you do NOT pass a `preflight` field.

## End-to-end agent workflow

```
[Task start]
  → call notra:notra-preflight <taskText>
  → record matchedPractices[].recommended_option ids
[Task execution]
  → for each remembered recommended option, decide as you work: did you actually apply it?
[Task end]
  → construct JSON input with adopted: [...applied option ids], notApplicable: [...rejected option ids]
  → call notra:notra-auto-crystallize <projectRoot> <inputFile>
```
