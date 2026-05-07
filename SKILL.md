---
name: project-knowledge-skill
description: Build and maintain a project-serving knowledge base inside the current project's `.notra/` directory. Use when Codex should initialize a project knowledge base, inspect current project knowledge status, rebuild the project knowledge graph, or crystallize stable knowledge from the current task into project-local Markdown.
---

# Notra Skill

Treat `.notra/` as the only fact source for a project's persisted knowledge.

## Core Rules

- Write project knowledge only under `.notra/`
- Read only local code and local docs for `notra:notra-init`
- Do not read `git log` or browse the web for project analysis
- Do not modify business code as part of knowledge maintenance
- Keep Obsidian-facing files (`index.md`, `log.md`, `_views/`, `.obsidian/`) derived from Markdown knowledge
- Before finishing a task, do one lightweight crystallization judgment
- Prefer `notra:notra-auto-crystallize` after task completion when touched files and a task summary are available
- If `.notra/project-profile.md` is missing, skip project knowledge workflows and suggest `notra:notra-init` only when the user wants this project to opt in
- Use `notra:notra-crystallize` with a JSON input file when recording hand-curated adopted nodes or stable updates

## Skill Entry Points

- `notra:notra-init`: analyze the current project and bootstrap `.notra/`
- `notra:notra-preflight`: inspect project knowledge before a task and return matching practices or local evidence hints
- `notra:notra-status`: summarize current project knowledge state
- `notra:notra-graph`: rebuild graph data and graph page from `.notra/`
- `notra:notra-crystallize`: persist a session and, when justified, update stable or incubating knowledge
- `notra:notra-auto-crystallize`: infer adopted recommendations or new incubating candidates from task text and touched files
- `notra:notra-lint`: report recommendation-pool lifecycle governance, evidence health, and possible duplicate knowledge without modifying files
- `notra:notra-govern`: automatically apply reversible governance actions such as promotion, demotion, and strong duplicate rejection
- `notra:notra-serve`: serve the project knowledge graph locally

## Knowledge Rules

- Markdown is the only fact source
- New stable insights should default into low-score incubating space unless they are already clearly project defaults
- `session` records are always allowed; knowledge nodes require stable evidence
- `.notra/` is an Obsidian-compatible vault; generated node bodies should keep `Links` sections useful for backlink navigation
- `notra:notra-preflight` output is context-budgeted: load full node Markdown or source files only after a summarized match needs deeper verification
- `notra:notra-lint` governance findings are review prompts only: promotion candidates, eviction candidates, and possible duplicates still require human judgment before moving or deleting files
- `notra:notra-govern` may move Markdown nodes between stable and incubating directories, but it must not physically delete knowledge files

## Crystallization Input

`notra:notra-auto-crystallize` accepts a JSON input file after the project path. Use it at task end when the task adopted existing recommendations or produced a new code practice that should start in incubation.

```json
{
  "sessionId": "session-YYYY-MM-DD-topic",
  "title": "本轮任务标题",
  "topic": "本轮任务主题",
  "taskText": "用于匹配已有实践的任务描述",
  "decisionSummary": "一句话总结本轮关键决策。",
  "touchedFiles": [],
  "adoptedNodeIds": [],
  "incubatingNodes": [],
  "stableUpdates": []
}
```
