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
- Expect `log.md` and Obsidian `_views/` to be refreshed after crystallization.
- Report the result in Chinese and include whether this run only wrote a session or also updated incubating or stable knowledge.

## JSON Input Shape

```json
{
  "sessionId": "session-YYYY-MM-DD-topic",
  "title": "本轮任务标题",
  "topic": "本轮任务主题",
  "decisionSummary": "一句话总结本轮关键决策。",
  "touchedFiles": [],
  "adoptedNodeIds": [],
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
