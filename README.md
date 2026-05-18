# Notra

Notra 是一套面向 Codex、Claude Code 和命令行自动化的项目知识沉淀工具。它把长期项目里的代码实践、推荐方案、会话结论、用户偏好和证据关系保存到项目自己的 `.notra/` 目录中，让后续开发任务可以先查已有项目知识，再决定是否扫描源码或创建新的候选知识。

Notra 不保存完整代码库，也不替代 Git。它关注的是“这个项目通常怎么做”：哪些实践已经稳定、哪些方案被推荐、哪些知识仍在孵化、哪些用户偏好应该在后续模型问答中被提醒。

## 核心能力

- **任务前检索**：`notra start` / `notra-preflight` 会返回匹配实践、推荐方案、证据路径和用户画像提示。
- **任务后沉淀**：`notra finish` / `notra-auto-crystallize` 会自动记录 session、采纳推荐方案，必要时创建孵化知识。
- **手动结晶**：`notra crystallize` 支持显式写入采纳节点、孵化节点、稳定更新和用户记忆。
- **用户画像记忆**：通过 `userMemory` 记录“用户纠正/偏好”，后续 `start` 会在 `userMemory.profileHints` 中回流。
- **推荐池治理**：`notra lint` 检查证据、推荐池、重复节点和晋升候选；`notra govern` 执行可逆治理动作。
- **图谱预览**：`notra graph` 生成图谱数据和页面；`notra serve` 本地预览 `.notra/graph/knowledge-graph.html`。
- **多平台插件**：同一套 Notra 能力可安装到 Codex、Claude Code 或通用 `.agents/skills/` 目录。

## 工作流

日常最短路径：

```bash
notra init
notra start "实现 HTTP 请求封装"
notra finish "完成 HTTP 请求封装"
notra status
```

推荐模型协作节奏：

1. 任务开始前运行 `notra start "任务描述"`。
2. 如果 `mode=knowledge-hit`，优先读取返回的 `matchedPractices`、`recommendedOptions` 和 `evidenceHints`。
3. 如果 `mode=needs-project-scan`，只检查返回的本地源码线索，不把整个项目塞进上下文。
4. 任务完成后运行 `notra finish "任务总结"`，自动沉淀采纳或新候选知识。
5. 定期运行 `notra lint` 和 `notra govern`，把多次采纳的孵化知识转入稳定区。

需要机器可读输出时加 `--json`：

```bash
notra start "实现 HTTP 请求封装" --json
notra finish "完成 HTTP 请求封装" --json
notra status --json
```

## 知识模型

`.notra/` 是项目级知识库，也是唯一持久化事实源。图谱、索引、Obsidian 视图和本地预览页面都从这些 Markdown 文件生成。

主要节点类型：

- `project_profile`：项目画像，记录技术栈、默认规则和项目偏好方案。
- `practice`：可复用实践，例如“HTTP 调用应统一封装”。
- `option`：实践下的候选方案，例如“统一 client”。
- `rule`：约束性规则。
- `context` / `constraint`：适用场景和限制条件。
- `session`：一次任务的历史记录。

知识生命周期：

- 新知识默认进入 `incubating/`。
- 多次被采纳后成为 `incubating-promotion-candidate`。
- 推荐池最多保留 3 个方案。
- 被淘汰或人工打回的方案不会物理删除，会退回孵化区并标记状态。
- `notra govern` 只做可逆动作：晋升、降级、标记重复或打回。

## 用户画像记忆

Notra 可以记录模型问答中的用户偏好，尤其适合处理“模型建议方向”和“用户真实意图”不一致的情况。

手动写入示例：

```json
{
  "sessionId": "session-2026-05-17-local-memory-test",
  "title": "本地记忆测试",
  "topic": "模型问答偏好",
  "decisionSummary": "记录一次用户偏好修正。",
  "userMemory": {
    "kind": "intent-mismatch",
    "assistantSuggestion": "先讨论完整架构方案。",
    "userReply": "我想先要可执行的本地测试步骤。",
    "inferredPreference": "用户倾向先拿到可执行验证流程，再讨论抽象设计。",
    "confidence": 0.82
  }
}
```

运行：

```bash
notra crystallize <project-root> --input memory-input.json
notra start "本地验证插件知识库和记忆功能" --json
```

后续 `start` 输出会包含：

```json
{
  "userMemory": {
    "profileHints": [
      "用户倾向先拿到可执行验证流程，再讨论抽象设计。"
    ]
  }
}
```

## 安装

### 本仓库开发环境

```bash
pnpm install
pnpm build:ts
pnpm run check
```

本地直接使用 CLI：

```bash
./bin/notra.mjs --help
./bin/notra.mjs init --project-root <project-root> --project-only --yes
```

发布包安装后可直接使用：

```bash
npm install -g @snailuu/notra
notra init
```

### Codex 插件

本地开发安装：

```bash
pnpm codex:install
```

安装后需要完全重启 Codex。技能名带插件前缀：

```text
notra:notra-init
notra:notra-preflight
notra:notra-status
notra:notra-graph
notra:notra-crystallize
notra:notra-auto-crystallize
notra:notra-lint
notra:notra-govern
notra:notra-serve
```

卸载：

```bash
pnpm codex:uninstall
```

### Claude Code 插件

通过 Claude Code 插件命令安装：

```bash
/plugin marketplace add snailuu/notra
/plugin install notra@snailuu
```

本地调试也可以使用仓库路径：

```bash
/plugin marketplace add /path/to/notra
/plugin install notra@snailuu
```

安装后需要完全重启 Claude Code。技能名不带 `notra:` 前缀：

```text
notra-init
notra-preflight
notra-status
notra-graph
notra-crystallize
notra-auto-crystallize
notra-lint
notra-govern
notra-serve
```

## CLI 命令

### 初始化

```bash
notra init
notra init --project-root <project-root>
notra init --project-only --yes
notra init --platform-only --codex
notra project-init <project-root>
```

常用选项：

- `--project-root, -C <path>`：指定目标项目。
- `--json`：输出机器可读 JSON。
- `--yes, -y`：跳过确认，使用默认值。
- `--no-interactive`：禁用交互式提示。
- `--dry-run`：只预览写入内容。
- `--force`：覆盖冲突文件。
- `--skip-existing`：跳过冲突文件。
- `--platform-only`：只安装平台 skill/runtime。
- `--project-only`：只初始化 `.notra/` 知识库。
- `--claude | --codex | --agents | --all`：选择安装平台。

### 任务开始前检索

```bash
notra start "实现 HTTP 请求封装"
notra preflight <project-root> "实现 HTTP 请求封装"
```

输出模式：

- `no-knowledge`：项目没有 `.notra/project-profile.md`，不会扫描代码。
- `knowledge-hit`：命中已有实践和推荐方案。
- `needs-project-scan`：没有命中知识，但返回本地 evidence hints。

### 任务结束后沉淀

```bash
notra finish "完成 HTTP 请求封装"
notra auto-crystallize <project-root> <auto-crystallize-input.json>
notra auto-crystallize <project-root> --input auto-crystallize-input.json
```

`finish` 会执行：

- 自动结晶 session。
- 自动推断采纳推荐方案。
- 必要时创建孵化中的 practice 和 option。
- 运行 lint 并生成状态摘要。

### 手动结晶

```bash
notra crystallize <project-root> <crystallize-input.json>
notra crystallize <project-root> --input crystallize-input.json
```

适合明确知道要写入哪些内容时使用：

- `adoptedNodeIds`
- `incubatingNodes`
- `stableUpdates`
- `userMemory`

模板位于：

```text
templates/crystallize-input-template.json
templates/auto-crystallize-input-template.json
```

### 健康检查与治理

```bash
notra lint <project-root>
notra govern <project-root>
notra doctor --strict
```

`lint` 会报告：

- `node-missing-evidence`
- `node-volatile-evidence`
- `option-missing-practice`
- `practice-empty-recommendation-pool`
- `incubating-promotion-candidate`
- `recommendation-pool-eviction-candidate`
- `possible-duplicate-node`

`govern` 会自动执行可逆治理：

- 达到采纳阈值的孵化节点转入稳定区。
- 推荐池外的方案退回孵化区并标记 rejected。
- 强重复节点保留更强节点，另一个标记 duplicate。
- 不会物理删除知识文件。

### 图谱

```bash
notra graph <project-root>
notra serve <project-root> 8124
```

本地预览地址：

```text
http://127.0.0.1:8124/graph/knowledge-graph.html
```

图谱页支持：

- 查看 practice、option、rule、context 的关系。
- 搜索主题、候选方案、场景、约束和规则。
- 查看正文、推荐池、分数和 evidence。
- 通过治理 API 打回不合适节点。

## `.notra/` 目录

初始化后，目标项目会出现：

```text
.notra/
├─ project-profile.md
├─ practices/
├─ options/
├─ rules/
├─ contexts/
├─ constraints/
├─ incubating/
│  ├─ practices/
│  ├─ options/
│  ├─ rules/
│  ├─ contexts/
│  └─ constraints/
├─ sessions/
├─ state/
│  ├─ runtime-state.json
│  ├─ usage-index.json
│  └─ user-memory.json
├─ graph/
│  ├─ graph-data.json
│  ├─ graph-index.json
│  └─ knowledge-graph.html
├─ _views/
├─ .obsidian/
├─ templates/
├─ tools/notra-runtime/
└─ open-graph.cmd
```

Obsidian 可以直接打开 `.notra/` 作为 vault。系统会维护：

- `index.md`
- `log.md`
- `_views/practices.md`
- `_views/incubating.md`
- `_views/sessions.md`
- `.obsidian/app.json`
- `.obsidian/graph.json`

## 证据规则

`source_evidence` 应指向长期存在的项目源码相对路径，例如：

```text
src/api/client.ts
src/runtime/scheduler.ts
```

以下内容不会作为长期证据：

- `.worktrees/`
- `.notra/`
- `.agents/`
- `.codex/`
- `node_modules/`
- `docs/`
- `task_plan.md`
- `findings.md`
- `progress.md`

这些内容可以帮助当前对话理解上下文，但不能支撑长期推荐实践。

## 技能文件说明

仓库根目录的 `SKILL.md` 是 Notra 的总纲型 skill 说明，用来描述项目知识库的整体原则和入口。插件真正暴露给 Codex / Claude Code 的技能位于：

```text
plugins/notra/skills/
```

根 `SKILL.md` 更像项目级说明；`plugins/notra/skills/notra-*/SKILL.md` 才是具体可调用入口。

## 仓库结构

```text
.
├─ .agents/                    # 本地 marketplace 示例
├─ assets/                     # 图谱前端资产模板
├─ bin/                        # notra CLI 入口
├─ knowledge/                  # 通用图谱原型和回归验证资产
├─ plugins/notra/              # Codex / Claude Code 插件包
│  ├─ .codex-plugin/
│  ├─ .claude-plugin/
│  ├─ skills/
│  └─ scripts/
├─ scripts/                    # 兼容运行脚本和安装脚本
├─ src/                        # TypeScript CLI / 核心实现
├─ templates/                  # 知识节点和输入 JSON 模板
├─ tests/                      # Node test 回归测试
├─ SKILL.md                    # 根 skill 总纲说明
└─ README.md
```

## 开发验证

```bash
pnpm build:ts
pnpm test
pnpm run check
```

`pnpm run check` 会执行：

- TypeScript 构建与类型检查。
- Node test 回归测试。
- `pnpm audit --audit-level moderate` 安全审计。

当前测试覆盖：

- 初始化扫描与证据过滤。
- 任务前 preflight 和上下文预算。
- 自动结晶与手动结晶。
- 用户画像记忆写入、回流、边界和并发。
- 推荐池治理和图谱重建。
- 图谱页面、搜索、焦点和治理交互。
- Codex / Claude 插件安装路径。
- 发布内容净化。

## 本地端到端验收建议

可以用一个临时项目验证完整链路：

```bash
mkdir -p /tmp/notra-demo/src/api
cat > /tmp/notra-demo/package.json <<'JSON'
{ "name": "notra-demo", "type": "module", "dependencies": { "vue": "^3.5.0" } }
JSON
cat > /tmp/notra-demo/src/api/client.ts <<'TS'
export async function requestJson(path: string) {
  return await fetch(`/api${path}`);
}
TS

notra init --project-root /tmp/notra-demo --project-only --yes
notra start --project-root /tmp/notra-demo "实现 HTTP 请求封装" --json
notra finish --project-root /tmp/notra-demo "完成 HTTP 请求封装" --json
notra lint /tmp/notra-demo
notra graph /tmp/notra-demo
notra serve /tmp/notra-demo 8124
```

打开：

```text
http://127.0.0.1:8124/graph/knowledge-graph.html
```
