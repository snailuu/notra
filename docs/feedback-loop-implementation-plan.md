# Notra 反馈闭环改造 · 实施计划

> 创建日期：2026-06-01
> 状态：待启动 Phase 1
> 适用版本：notra ≥ 0.1.3
> 决策方式：经过多 agent 调研（mem0 / Graphiti / A-MEM / Generative Agents 等）+ 独立审查 + grill-me 决策树逐项收敛

---

## 背景与目标

### 项目当前画像

notra 是"项目级 markdown 知识库 + 显式 lint/govern + 跨多平台 skill"形态的工具，在业界这一组合是独特位置。但当前"自进化"机制存在三个结构性缺陷：

1. **采纳推断的正向偏置**（`src/core/session/auto-crystallize.ts:295-305`）
   `inferAdoptedNodeIds` 把"preflight 命中 practice"等同于"被采纳"，导致系统**只有正反馈、没有负反馈**。被推荐过的方案下次任务命中就自动 `adopted_count++`，3 次就晋升 stable。这是数学上**会自我强化首批噪音**的设计。

2. **时间维度数据死字段**（`src/core/knowledge/graph-model.ts:117`）
   `last_used_at` 字段写入存在，但**所有排序逻辑都不读它**，等于白存。

3. **"自进化"名实不符**
   当前实质是"规则驱动 + 单向累加的使用计数"，距离业界（mem0 / Graphiti / A-MEM）已有的"反馈闭环 + 双时态 + 链接演化"等成熟范式有明显差距。

### 改造目标

把 notra 从"知识库 + 计数器"升级为真正双向反馈的"自进化记忆层"。三阶段递进：

- **Phase 1**：装上信号采集层（strong/weak/notApplicable 分级 + 观测日志）
- **Phase 2**：激活时间维度（冷藏开关）
- **Phase 3**：基于 Phase 1+2 收集到的真实数据，再设计负反馈（不预设常数）

### 设计哲学

**先建可观测的信号通路，再基于真实数据建闭环**——而不是凭直觉一次性把 `confidence *= 0.5`、`0.3` 阈值、`0.98^days` 这些常数全押上。

---

## 总览

| Phase | 目标 | 改动量 | 风险 | 何时启动 |
|---|---|---|---|---|
| **Phase 1** | 采纳信号分级 + 观测日志 | 中（4 文件 + 2 SKILL） | 低（向后兼容） | 立刻 |
| **Phase 2** | 时间维度（仅 strong 刷 last_used_at）+ 冷藏开关 | 小（2 文件） | 低 | Phase 1 上线 2 周后 |
| **Phase 3** | 负反馈（intent-mismatch → negative_signals） | 待定 | 由 Phase 1+2 数据决定 | Phase 1+2 各跑 2 周 + 观测数据后 |
| **附属清理** | 删除硬编码领域规则 `detectLongRunningAutoTaskPattern` | 小（删 50 行） | 低 | 跟 Phase 1 一起 |

**贯穿原则**：所有改动**向后兼容**——老的 `.notra/state/usage-index.json`、老节点 frontmatter 不需要迁移脚本，读取时 lazy 转换。

---

## Phase 1：采纳信号分级（核心，立刻可做）

### 1.1 数据结构变更

#### `.notra/state/usage-index.json` 节点 entry 扩展（向后兼容）

```jsonc
// 老格式（继续可读）
{ "session_mentions": 3, "adopted_count": 2, "last_used_at": "2025-05-20", "last_session_id": "..." }

// 新格式
{
  "session_mentions": 3,
  "adopted_count": 2,           // 保留，新写入时 = strong_count（lazy 迁移读老数据用）
  "strong_count": 2,            // 新增：agent 明示 adopted 且 evidence 校验通过
  "weak_count": 5,              // 新增：preflight 命中但 agent 未明示 / 校验未过
  "not_applicable_count": 1,    // 新增：agent 明示不适用（观测用，不进打分）
  "last_used_at": "2025-05-20",
  "last_session_id": "..."
}
```

#### 读取时 lazy 迁移（`graph-model.ts:114-119` 改 default）

```js
node.usage_stats = usageIndex[node.id] || {
  session_mentions: 0,
  adopted_count: 0,
  strong_count: 0,
  weak_count: 0,
  not_applicable_count: 0,
  last_used_at: null,
  last_session_id: null
};
// 兼容老数据：strong_count 缺失时用 adopted_count 兜底
if (node.usage_stats.strong_count == null) {
  node.usage_stats.strong_count = node.usage_stats.adopted_count || 0;
}
node.usage_stats.weak_count = node.usage_stats.weak_count || 0;
node.usage_stats.not_applicable_count = node.usage_stats.not_applicable_count || 0;
```

#### 新文件 `.notra/state/adoption_observations.jsonl`（追加式观测日志）

```jsonl
{"ts":"2025-06-01T12:30:00Z","session_id":"session-...","node_id":"option-foo","declared":"adopted","evidence_overlap":true,"signal":"strong","touched_files_count":4}
{"ts":"2025-06-01T12:30:00Z","session_id":"session-...","node_id":"option-bar","declared":"missing","evidence_overlap":false,"signal":"weak","touched_files_count":4}
{"ts":"2025-06-01T12:30:00Z","session_id":"session-...","node_id":"option-baz","declared":"not_applicable","evidence_overlap":null,"signal":"none","touched_files_count":4}
```

**字段含义**：
- `declared`: `adopted` | `not_applicable` | `missing`（agent 没在两个列表里写）
- `evidence_overlap`: 节点 `evidence_paths ∩ touched_files` 是否非空，`null` = 未做检查（declared=not_applicable 时）
- `signal`: 最终分类 `strong` | `weak` | `none`

这个文件**只追加不读**，纯供 2 周后人工/脚本分析 agent 遵从率。

### 1.2 代码改动清单

> **改动执行顺序**（避免中途断链）：
> 1. 新建 `src/core/session/adoption-signal.ts`（独立、无依赖）
> 2. 改 `src/core/knowledge/graph-model.ts`（改 1/2/3：公式 → 晋升 → POLICY 字段；行号会从上往下漂移，请按顺序）
> 3. 改 `src/core/session/crystallize.ts`（改 1-5：input schema → updateUsageIndex → 主流程接入）
> 4. 改 `src/core/session/auto-crystallize.ts`（改 1/2/3：删 infer → 透传 preflight → 删硬编码规则）
> 5. 改 `src/core/governance/lint.ts`（同步字段名）
> 6. 改两个 SKILL.md
> 7. 改写/删除受影响测试，新增 adoption-signal 测试
> 8. `pnpm typecheck && pnpm test` 验证
>
> **行号说明**：本文档所有 `:行号` 标注基于当前 main 分支状态；执行任何修改后，同一文件后续步骤的行号会下移，以函数名/标识符为准。

#### a) `src/core/knowledge/graph-model.ts`

**改 1**：`computeUsageAdjustment` 公式（`:57-61`）

```js
// 老
export function computeUsageAdjustment(usageStats = {}) {
  const adoptedCount = Number(usageStats.adopted_count || 0);
  const sessionMentions = Number(usageStats.session_mentions || 0);
  return Math.min(adoptedCount * 3 + sessionMentions, 15);
}

// 新
export function computeUsageAdjustment(usageStats = {}) {
  const strongCount = Number(
    usageStats.strong_count ?? usageStats.adopted_count ?? 0
  );
  const weakCount = Number(usageStats.weak_count || 0);
  return Math.min(strongCount * 3 + weakCount * 1, 15);
}
```

> 注意：保留 15 上限（已审查确认实际影响 ~42%，不是微调，且不破坏现有 balance）。

**改 2**：`attachLifecycleState` 晋升判据（`:453-471`）

```js
// 老
if (
  node.maturity === "incubating" &&
  Number(node.usage_stats?.adopted_count || 0) >= LIFECYCLE_POLICY.promotionAdoptedThreshold
) {
  reasons.push("adopted-threshold-met");
}

// 新（封死 weak 通道）
const strongCount = Number(
  node.usage_stats?.strong_count ?? node.usage_stats?.adopted_count ?? 0
);
if (
  node.maturity === "incubating" &&
  strongCount >= LIFECYCLE_POLICY.promotionStrongThreshold
) {
  reasons.push("strong-threshold-met");
}
```

**改 3**：`LIFECYCLE_POLICY` 字段重命名（`:32-35`）

```js
export const LIFECYCLE_POLICY = {
  recommendationPoolLimit: 3,
  promotionStrongThreshold: 3,    // 新名字，语义清晰
  promotionAdoptedThreshold: 3    // 保留作为 alias 防外部引用断裂
};
```

#### b) `src/core/session/crystallize.ts`

**改 1**：input schema 扩展（`:31-41`）

```js
export async function crystallizeSession(projectRootOrKnowledgeRoot, input = {}) {
  // ...
  // 老
  const adoptedNodeIds = input.adoptedNodeIds || [];

  // 新（两种字段都接，向后兼容）
  const adoptedNodeIds = input.adopted || input.adoptedNodeIds || [];
  const notApplicableNodeIds = input.notApplicable || [];
  // ...
}
```

**改 2**：新增 `classifyAdoptionSignals` 公共函数（建议放在新文件 `src/core/session/adoption-signal.ts`）

```ts
// adoption-signal.ts
export interface AdoptionClassification {
  strong: string[];        // adopted + evidence 校验通过
  weak: string[];          // adopted 但 evidence 校验失败，或 preflight 命中但 agent 缺声明
  notApplicable: string[]; // agent 明示不适用
  observations: AdoptionObservation[];  // 用于写 jsonl
}

export function classifyAdoptionSignals(params: {
  preflight: any;
  agentAdopted: string[];
  agentNotApplicable: string[];
  touchedFiles: string[];
  nodeMap: Map<string, { source_evidence?: string[] }>;
}): AdoptionClassification {
  const { preflight, agentAdopted, agentNotApplicable, touchedFiles, nodeMap } = params;
  const recommended = extractRecommendedNodeIds(preflight); // 从 preflight.matchedPractices 抽
  const result = { strong: [], weak: [], notApplicable: [...agentNotApplicable], observations: [] };

  const adoptedSet = new Set(agentAdopted);
  const notApplicableSet = new Set(agentNotApplicable);
  const touchedSet = new Set(touchedFiles);

  // 已 declared adopted 的：做 evidence 校验
  for (const nodeId of agentAdopted) {
    const node = nodeMap.get(nodeId);
    const overlap = hasEvidenceOverlap(node?.source_evidence || [], touchedSet);
    if (overlap) result.strong.push(nodeId);
    else result.weak.push(nodeId);
    result.observations.push({
      node_id: nodeId,
      declared: "adopted",
      evidence_overlap: overlap,
      signal: overlap ? "strong" : "weak"
    });
  }
  // declared not_applicable 的：不进 strong/weak，只记录
  for (const nodeId of agentNotApplicable) {
    result.observations.push({
      node_id: nodeId,
      declared: "not_applicable",
      evidence_overlap: null,
      signal: "none"
    });
  }
  // preflight 命中但 agent 既没说 adopted 也没说 not_applicable 的：weak
  for (const nodeId of recommended) {
    if (adoptedSet.has(nodeId) || notApplicableSet.has(nodeId)) continue;
    result.weak.push(nodeId);
    result.observations.push({
      node_id: nodeId,
      declared: "missing",
      evidence_overlap: false,
      signal: "weak"
    });
  }
  return result;
}

function hasEvidenceOverlap(evidencePaths: string[], touchedSet: Set<string>): boolean {
  // source_evidence 实测均为文件路径（normalizeEvidencePath 过滤后），无需前缀匹配
  return evidencePaths.some((p) => touchedSet.has(p));
}

// 从 preflight 输出抽出本次任务被推荐的 option id（每个 practice 取 recommended_option，与原 inferAdoptedNodeIds 语义一致）
function extractRecommendedNodeIds(preflight: any): string[] {
  if (!preflight || preflight.mode !== "knowledge-hit") return [];
  return dedupeValues(
    (preflight.matchedPractices || [])
      .map((practice) => practice.recommended_option)
      .filter(Boolean)
  );
}

// alias，给主流程调用用，语义等同 extractRecommendedNodeIds
export const recommendedFromPreflight = extractRecommendedNodeIds;

// 按 id 列表加载节点的 source_evidence。复用 buildProjectGraphFromDirectory 全量加载，按需提取
// 不新写"部分加载"优化：节点数量在项目级一般 < 200，全量加载已被 graph 构建走过一次，开销可接受
export async function loadNodeMapForIds(
  knowledgeRoot: string,
  ids: string[]
): Promise<Map<string, { source_evidence?: string[] }>> {
  if (!ids.length) return new Map();
  const { nodes } = await buildProjectGraphFromDirectory(knowledgeRoot);
  const wanted = new Set(ids);
  return new Map(
    nodes
      .filter((n: any) => wanted.has(n.id))
      .map((n: any) => [n.id, { source_evidence: n.source_evidence || [] }])
  );
}
```

> **evidence 校验策略说明**：`source_evidence` 在现有代码（`src/core/knowledge/evidence.ts`）中实测均为文件路径（如 `src/api/client.ts`），不会出现目录前缀。因此 `hasEvidenceOverlap` 用 `Set.has` 精确等值即可，**无需 `pathPrefixMatch`**。如果未来 evidence 引入目录路径（如 `src/api/`），再扩展此函数。
>
> **touched_files 归一化**：调用方传入前必须先经过 `normalizeEvidencePath`，保证与 evidence 路径格式一致（去掉 `./` 前缀、统一 `/` 分隔符）。

**改 3**：`updateUsageIndex` 拆为按信号类型计数（`:302-335`）

```ts
// 老签名（与实际代码一致）
async function updateUsageIndex(knowledgeRoot, { sessionId, adoptedNodeIds, mentionedNodeIds }) { ... }

// 新签名（按分类计数）
async function updateUsageIndex(knowledgeRoot, {
  sessionId,
  strongNodeIds,
  weakNodeIds,
  notApplicableNodeIds,
  mentionedNodeIds
}) {
  // ... 加锁、读 entry ...
  for (const nodeId of dedupeValues(strongNodeIds)) {
    const entry = ensureEntry(usageIndex, nodeId, sessionId);
    entry.strong_count = (entry.strong_count ?? entry.adopted_count ?? 0) + 1;
    entry.adopted_count = entry.strong_count; // 维持旧字段同步
    entry.last_used_at = extractDateFromSessionId(sessionId); // Phase 1 暂保持，Phase 2 改
    entry.last_session_id = sessionId;
  }
  for (const nodeId of dedupeValues(weakNodeIds)) {
    const entry = ensureEntry(usageIndex, nodeId, sessionId);
    entry.weak_count = (entry.weak_count || 0) + 1;
    // Phase 1：weak 不刷 last_used_at（与 Phase 2 一致行为，避免后续语义切换）
    entry.last_session_id = sessionId;
  }
  for (const nodeId of dedupeValues(notApplicableNodeIds)) {
    const entry = ensureEntry(usageIndex, nodeId, sessionId);
    entry.not_applicable_count = (entry.not_applicable_count || 0) + 1;
    entry.last_session_id = sessionId;
  }
  // ... session_mentions 逻辑保持不变 ...
}
```

**改 4**：新增 `appendAdoptionObservations` 写 jsonl（同文件）

```js
async function appendAdoptionObservations(knowledgeRoot, sessionId, observations, touchedFilesCount) {
  if (!observations?.length) return;
  const logPath = path.join(knowledgeRoot, "state", "adoption_observations.jsonl");
  const lines = observations.map((o) => JSON.stringify({
    ts: new Date().toISOString(),
    session_id: sessionId,
    touched_files_count: touchedFilesCount,
    ...o
  })).join("\n") + "\n";
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, lines, "utf8");
}
```

> **并发安全说明**：`fs.appendFile` 在 Node.js 内部是单次 `write` syscall（即使写入多行）。POSIX 保证 `O_APPEND` 模式下小于 `PIPE_BUF`（通常 4096 字节）的 write 是原子的——一个 session 的 observations 总长度通常远低于此，安全。**但**：(1) 若未来单次 session 的 observations 超过 4KB，需要切分写入或换用 `withStateLock`；(2) 跨进程并发场景（两个 notra 命令同时跑）依赖 OS 原子性，notra 当前设计是单进程顺序执行，无此风险。

**改 5**：`crystallizeSession` 主流程接入（约 `:79` 处）

```js
// 在调用 updateUsageIndex 前
const classification = input.preflight && input.touchedFiles
  ? classifyAdoptionSignals({
      preflight: input.preflight,
      agentAdopted: adoptedNodeIds,
      agentNotApplicable: notApplicableNodeIds,
      touchedFiles: input.touchedFiles,
      nodeMap: await loadNodeMapForIds(
        knowledgeRoot,
        [
          ...adoptedNodeIds,
          ...notApplicableNodeIds,
          ...recommendedFromPreflight(input.preflight)
        ]
      )
    })
  : { strong: adoptedNodeIds, weak: [], notApplicable: notApplicableNodeIds, observations: [] };
  // ↑ 没有 preflight/touchedFiles 时（manual crystallize 老调用）保留旧行为：adopted 全 strong

await updateUsageIndex(knowledgeRoot, {
  sessionId,
  strongNodeIds: classification.strong,
  weakNodeIds: classification.weak,
  notApplicableNodeIds: classification.notApplicable,
  mentionedNodeIds
});
await appendAdoptionObservations(
  knowledgeRoot,
  sessionId,
  classification.observations,
  input.touchedFiles?.length || 0
);
```

#### c) `src/core/session/auto-crystallize.ts`

**改 1**：**删除** `inferAdoptedNodeIds`（`:295-305`），改为传 preflight 让 crystallize 自己分类

```js
// 老（auto-crystallize.ts:28-30）
const adoptedNodeIds = Array.isArray(input.adoptedNodeIds)
  ? dedupeValues(input.adoptedNodeIds)
  : inferAdoptedNodeIds(preflight);

// 新（不再推断，agent 没声明就空，让 crystallize 走 weak 通道）
const adoptedNodeIds = Array.isArray(input.adopted)
  ? dedupeValues(input.adopted)
  : Array.isArray(input.adoptedNodeIds)
    ? dedupeValues(input.adoptedNodeIds)  // 兼容老字段
    : [];
const notApplicableNodeIds = Array.isArray(input.notApplicable)
  ? dedupeValues(input.notApplicable)
  : [];
```

**改 2**：把 preflight + touchedFiles 透传给 crystallize（`:40-50`）

```js
const crystallizeInput = {
  ...input,
  // ...
  touchedFiles,
  adopted: adoptedNodeIds,
  notApplicable: notApplicableNodeIds,
  preflight,  // 新增：让 crystallize 能做 weak 通道分类
  incubatingNodes,
  stableUpdates: input.stableUpdates || []
};
```

**改 3**：**删除** `detectLongRunningAutoTaskPattern`（`:373-418`，约 50 行硬编码领域规则）和 `buildIncubatingNodeMetadata` 里对它的调用（`:353-356`）

```js
// 删除整个 detectLongRunningAutoTaskPattern 函数
// buildIncubatingNodeMetadata 改为只走通用 slug 逻辑：
function buildIncubatingNodeMetadata({ input, taskText, touchedFiles }) {
  const slug = slugify(input.taskText || input.topic || input.title || taskText || "session");
  const title = input.title || input.topic || taskText || "新场景";
  const summary = input.decisionSummary || `从本轮任务中发现 ${title} 的候选实践。`;
  return {
    practiceId: `practice-${slug}`,
    optionId: `option-${slug}-candidate`,
    practiceTitle: `${title} 实践`,
    optionTitle: `${title} 候选方案`,
    practiceSummary: summary,
    optionSummary: summary,
    keywords: extractKeywords(taskText || title)
  };
}
```

#### d) `src/core/session/preflight.ts`

**本 Phase 不动**。Phase 2 才动 last_used_at 写入语义。

#### e) `src/core/governance/lint.ts`（**漏不得**：晋升判据改了，报告字段必须同步）

`lint.ts:140-145` 的 `incubating-promotion-candidate` issue 当前结构：

```ts
// 老
{
  code: "incubating-promotion-candidate",
  // ...
  adopted_count: Number(node.usage_stats?.adopted_count || 0),
  promotion_adopted_threshold: LIFECYCLE_POLICY.promotionAdoptedThreshold
}

// 新（与 attachLifecycleState 的新判据一致）
{
  code: "incubating-promotion-candidate",
  // ...
  strong_count: Number(
    node.usage_stats?.strong_count ?? node.usage_stats?.adopted_count ?? 0
  ),
  promotion_strong_threshold: LIFECYCLE_POLICY.promotionStrongThreshold,
  // 为外部消费者（如可能的可视化）保留老字段，避免破坏 JSON 输出契约
  adopted_count: Number(node.usage_stats?.adopted_count || 0),
  promotion_adopted_threshold: LIFECYCLE_POLICY.promotionAdoptedThreshold
}
```

> **为什么必须改**：如果只改 `attachLifecycleState` 不改 lint，会出现"系统按 strong_count 判断晋升、lint 报告却显示 adopted_count"的语义错位——用户看到 lint 报告 adopted_count=3 却没晋升、或 adopted_count=0 却晋升候选，会非常困惑。

### 1.3 SKILL.md 改造

#### a) `plugins/notra/skills/notra-auto-crystallize/SKILL.md`

**改 Required Behavior 第 17 行**：

```diff
- If `adoptedNodeIds` is omitted, allow the script to infer adopted recommended options from `notra:notra-preflight` matches.
+ For each recommended option from `notra:notra-preflight` matches, you MUST classify it into ONE of:
+   - `adopted`: you actually applied this option in this task (will require git evidence overlap to count as strong signal)
+   - `notApplicable`: this option did not fit this task context
+ Recommended options that appear in NEITHER list are recorded as weak evidence (you forgot to classify them).
+ Do NOT default to `adopted` — only include options you consciously applied.
```

**改 JSON Input Shape**（`:21-35`）：

```diff
  {
    "sessionId": "session-YYYY-MM-DD-topic",
    "title": "本轮任务标题",
    "topic": "本轮任务主题",
    "taskText": "用于匹配已有实践的任务描述",
    "decisionSummary": "一句话总结本轮关键决策。",
    "touchedFiles": [],
-   "adoptedNodeIds": [],
+   "adopted": [],
+   "notApplicable": [],
    "incubatingNodes": [],
    "stableUpdates": []
  }
```

#### b) `plugins/notra/skills/notra-crystallize/SKILL.md`

同样改 JSON shape，加 `notApplicable` 字段；Required Behavior 加一句说明 adopted/notApplicable 双重声明语义。

### 1.3a agent 端到端工作流（**关键**：spec 必须明确这条链路）

agent 在任务全周期内需要完成的动作（这部分内容应同步反映到 SKILL.md 的 Required Behavior 中）：

```
[任务开始]
  │
  │ 1. 调 notra:notra-preflight <taskText>
  │    → 拿到 preflight 输出：
  │      {
  │        mode: "knowledge-hit",
  │        matchedPractices: [
  │          { id: "practice-...", recommended_option: "option-foo", ... },
  │          { id: "practice-...", recommended_option: "option-bar", ... }
  │        ]
  │      }
  │
  │ 2. 记住 recommended_option 列表：["option-foo", "option-bar"]
  │
[任务执行（编码、调试、测试...）]
  │
  │ agent 一边执行任务一边判断：
  │   - 真的用上了 option-foo 的方案？→ 准备放进 adopted[]
  │   - option-bar 这次场景不适用？→ 准备放进 notApplicable[]
  │
[任务结束]
  │
  │ 3. 构造 input JSON 文件（可写在临时路径，例如 /tmp/notra-crystallize-<ts>.json）：
  │    {
  │      "sessionId": "session-2026-06-01-feature-x",
  │      "title": "...",
  │      "topic": "...",
  │      "taskText": "...",
  │      "decisionSummary": "...",
  │      "touchedFiles": ["src/api/foo.ts", "src/api/bar.ts"],  // 可省略，脚本会从 git status 自动取
  │      "adopted": ["option-foo"],
  │      "notApplicable": ["option-bar"]
  │    }
  │
  │ 4. 调 notra:notra-auto-crystallize <projectRoot> <inputFile>
  │    → 脚本读 JSON、跑 classifyAdoptionSignals、
  │      写 usage-index.json（strong_count++）、写 adoption_observations.jsonl
```

**关键约束**（必须写进 SKILL.md）：

1. **preflight 输出必须被记住到任务结束**——agent 在调 auto-crystallize 时需要回填 adopted/notApplicable，否则只能走 weak 兜底
2. **adopted 不是默认状态**——只有 agent 在任务中**实际应用**了某 option（代码中能找到证据）才放进 adopted；否则放 notApplicable 或干脆不写（兜底为 weak）
3. **`touchedFiles` 可不传**：脚本会自动 `git status` 取（已实现，见 `auto-crystallize.ts:resolveTouchedFiles`）
4. **`preflight` 字段不需要 agent 传**：脚本在内部调 `runPreflight`，结果直接用——agent 只需传 `adopted` / `notApplicable` 列表

**Fallback 路径**（对未改造的老 agent 兼容）：
- 老 agent 传 `adoptedNodeIds`（旧字段）：被 `crystallize.ts` 改 1 兼容处理为 `adopted`
- 老 agent 完全不传：preflight 命中的所有 recommended_option 走 weak 通道，不影响 strong_count，安全

### 1.4 测试设计

新增 `tests/adoption-signal.test.ts`：

```ts
test("strong: agent adopted + evidence overlap with touched files", () => {
  const r = classifyAdoptionSignals({
    preflight: { mode: "knowledge-hit", matchedPractices: [{ recommended_option: "option-foo" }] },
    agentAdopted: ["option-foo"],
    agentNotApplicable: [],
    touchedFiles: ["src/api/foo.ts"],
    nodeMap: new Map([["option-foo", { source_evidence: ["src/api/foo.ts"] }]])
  });
  assert.deepEqual(r.strong, ["option-foo"]);
  assert.deepEqual(r.weak, []);
});

test("weak: agent adopted but no evidence overlap", () => { /* ... */ });
test("weak: preflight hit but agent missing classification", () => { /* ... */ });
test("notApplicable: agent explicitly declared", () => { /* ... */ });
test("strong + weak both produce observation entries", () => { /* ... */ });
```

新增 `tests/usage-index-classification.test.ts`：模拟 3 个 session 序列，断言 strong_count/weak_count 演化，断言 weak 不导致晋升（`strong_count = 0, weak_count = 10` 时 `lifecycle_state !== "promotion_candidate"`）。

#### 必须同步改写/删除的现有测试（不改 CI 必红）

| 测试 | 行 | 当前断言 | 处理 |
|---|---|---|---|
| `tests/auto-crystallize.test.ts:42-74` records adopted recommendations | 行 55 `adoptedNodeIds === ["option-unified-client"]`、行 71 `adopted_count === 2`、行 72 `session match /adopted_nodes:/` | **改写**：在 input 加 `adopted: ["option-unified-client"]`；断言不变（agent 显式声明 + evidence 命中 → strong → adopted_count 仍递增） |
| `tests/auto-crystallize.test.ts:253-311` long-running scheduler 硬编码 | 整段 | **整段删除**（`detectLongRunningAutoTaskPattern` 已删，测试失去意义） |
| `tests/auto-crystallize.test.ts:313-343` CLI JSON 输入 | 行 341 `adoptedNodeIds === ["option-unified-client"]` | **改写**：JSON 加 `"adopted": ["option-unified-client"]` 字段，断言不变 |
| `tests/auto-crystallize.test.ts:25-40` no knowledge | 行 36 `adoptedNodeIds === []` | **不动**（no-knowledge 路径走 buildNoKnowledgeResult，与新逻辑无关） |
| `tests/auto-crystallize.test.ts:76-122` no match creates incubating | 行 89 `adoptedNodeIds === []` | **不动**（incubating 流程不变） |
| `tests/auto-crystallize.test.ts:124-145` volatile artifacts filter | 无 adopted 断言 | **不动** |

#### 还需要补的测试

| 测试目标 | 验证什么 |
|---|---|
| agent 不传 adopted/notApplicable 时，preflight 命中 → weak | `strong_count === 0, weak_count === 1` |
| agent 传 adopted 但 evidence 不命中 → 降为 weak | `strong_count === 0, weak_count === 1`，jsonl 记录 `signal: "weak", evidence_overlap: false` |
| agent 同时声明 adopted 和 notApplicable 同一节点 → adopted 优先 | 实现层兜底，避免歧义 |
| weak_count 累积到 10 也不晋升 | `lifecycle_state !== "promotion_candidate"`，证明 weak 通道被封死 |
| lazy 迁移：老 usage-index（只有 adopted_count）正确读出 strong_count | `node.usage_stats.strong_count === 旧 adopted_count` |
| `adoption_observations.jsonl` 内容格式正确 | 每行可 JSON.parse，包含必填字段 |

**回归底线**：`pnpm test` 全过、`pnpm typecheck` 全过。

### 1.5 验收标准

- [ ] 原 125 个旧测试 + 改写后的 4 个测试 + 新增 6 个测试全过
- [ ] `pnpm typecheck` 通过
- [ ] 老 `.notra/state/usage-index.json` 可直接读，effective_score 数值与改造前一致（lazy 迁移正确）
- [ ] `notra graph` 重建后，graph-data.json 中的 effective_score 反映新公式（见下方"graph 重建"）
- [ ] 端到端 demo 通过（步骤见下）

#### 端到端 demo 验收步骤

```bash
# 准备：用一个已有 .notra/practices/ 的项目
cd ~/some-project-with-notra

# 1. 跑 preflight，记下 matchedPractices 里的 recommended_option（假设是 option-A 和 option-B）
node /path/to/notra/plugins/notra/scripts/notra-preflight.mjs . "实现一个新接口"

# 2. 构造 input JSON（模拟 agent 双重声明：A 用了、B 不适用）
cat > /tmp/notra-demo-input.json <<'EOF'
{
  "sessionId": "session-2026-06-02-demo",
  "title": "demo task",
  "topic": "demo",
  "taskText": "实现一个新接口",
  "decisionSummary": "demo: 测试反馈闭环",
  "touchedFiles": ["src/api/foo.ts"],
  "adopted": ["option-A"],
  "notApplicable": ["option-B"]
}
EOF

# 3. 触发结晶
node /path/to/notra/plugins/notra/scripts/notra-auto-crystallize.mjs . /tmp/notra-demo-input.json

# 4. 验证
cat .notra/state/usage-index.json | jq '."option-A", ."option-B"'
#   预期：option-A.strong_count++ (假设 evidence 命中) 或 weak_count++ (evidence 不命中)
#         option-B.not_applicable_count++

cat .notra/state/adoption_observations.jsonl | tail -2
#   预期：两行 JSON，分别是 option-A (declared:adopted) 和 option-B (declared:not_applicable)

# 5. 再跑一次但不传 adopted/notApplicable（模拟 agent 忘记声明）
cat > /tmp/notra-demo-input-2.json <<'EOF'
{
  "sessionId": "session-2026-06-02-demo-weak",
  "title": "demo weak fallback",
  "taskText": "实现一个新接口",
  "decisionSummary": "demo: 兜底为 weak",
  "touchedFiles": ["src/api/foo.ts"]
}
EOF
node .../notra-auto-crystallize.mjs . /tmp/notra-demo-input-2.json

cat .notra/state/adoption_observations.jsonl | tail -2
#   预期：option-A 和 option-B 都出现 declared:"missing", signal:"weak"
```

#### graph 重建

`computeUsageAdjustment` 公式改变后，**已经持久化的 `.notra/graph/graph-data.json` 不会自动反映新公式**。需要在 Phase 1 上线后**手动跑一次**：

```bash
notra graph .  # 强制重建 graph-data.json
```

之后每次 crystallize 会自动重建（与改造前行为一致，`crystallize.ts` 末尾的 `buildProjectGraphArtifacts` 调用未变）。

`notra status` 和 `notra doctor` 的输出字段当前不展示 strong_count/weak_count，**Phase 1 暂不改**——等 Phase 2 数据起来后，看是否需要在 status 加"反馈闭环健康度"小节再统一改。

---

### 1.6 Rollback 策略

Phase 1 的所有改动设计上是**回滚安全的**，但要明确路径以减少回滚时的犹豫：

**数据层影响**：

| 改动 | 回滚到老代码后的行为 |
|---|---|
| `usage-index.json` 新增 `strong_count` / `weak_count` / `not_applicable_count` 字段 | 老代码完全忽略这些字段（只读 `adopted_count`） |
| `adopted_count` 与 `strong_count` 同步更新（新代码写入时） | 老代码读 `adopted_count` 仍是正确递增值，**晋升判据可正常工作** |
| 新增 `adoption_observations.jsonl` | 老代码不读不写，文件残留但无害；想清除直接 `rm` |
| 老节点 frontmatter 未改 | 完全无影响 |

**结论**：Phase 1 可以"git revert PR + 删 jsonl 文件"**完全回滚**，不需要回滚脚本，已有数据不会损坏。

**回滚命令**：
```bash
git revert <phase-1-commit>
rm -f .notra/state/adoption_observations.jsonl  # 可选，残留也无害
notra graph .  # 重建 graph-data.json
```

**Phase 2 的 rollback 风险更高**（因为 govern 物理迁移了文件），见 2.5 节。

---

## Phase 2：时间维度（Phase 1 上线 2 周后）

### 2.1 启动判据（必须先满足）

- Phase 1 至少跑过 **20 次** auto-crystallize（看 `adoption_observations.jsonl` 行数）
- strong/weak/missing 三类比例可观测：
  - 如果 missing 占比 > 70% → agent 遵从率太低，先优化 SKILL 文案不要急着上 Phase 2
  - 如果 strong/(strong+weak) > 40% → agent 配合良好，可以推进

### 2.2 代码改动

#### a) `src/core/session/crystallize.ts`

`updateUsageIndex` 中 weak 通道 **保持不刷 `last_used_at`**（Phase 1 已经这么做了，确认一致）；strong 通道照常刷。

#### b) `src/core/knowledge/graph-model.ts`

新增 `LIFECYCLE_POLICY.coldStorageDays = 90`。

修改 `attachLifecycleState`（`:453-471`）增加冷藏检查：

```js
function attachLifecycleState(node) {
  const reasons = [];
  if (node.review_status === "rejected") { /* ... */ return; }

  const strongCount = Number(node.usage_stats?.strong_count ?? node.usage_stats?.adopted_count ?? 0);
  const lastUsedAt = node.usage_stats?.last_used_at;

  // 冷藏检查（stable 才会被冷藏；incubating 本来就在路上）
  if (node.maturity === "stable" && lastUsedAt) {
    const daysSince = computeDaysSince(lastUsedAt); // 不用 Math/Date，测试时注入 now
    if (daysSince > LIFECYCLE_POLICY.coldStorageDays) {
      reasons.push("cold-storage");
    }
  }

  // 晋升判断（incubating）
  if (node.maturity === "incubating" && strongCount >= LIFECYCLE_POLICY.promotionStrongThreshold) {
    reasons.push("strong-threshold-met");
  }

  node.lifecycle_state = reasons.length > 0 ? lifecycleStateFromReasons(reasons) : "active";
  node.lifecycle_reasons = reasons;
}

function lifecycleStateFromReasons(reasons) {
  if (reasons.includes("cold-storage")) return "cold-storage-candidate";
  if (reasons.includes("strong-threshold-met")) return "promotion_candidate";
  return "active";
}

// 新增工具函数（建议放在 graph-model.ts 顶部，与 LIFECYCLE_POLICY 同区域）
// 接受 ISO date string（YYYY-MM-DD 或 完整 ISO 时间戳）
// `now` 可注入，便于测试
export function computeDaysSince(dateStr: string, now: Date = new Date()): number {
  if (!dateStr) return Infinity;
  const then = new Date(dateStr);
  if (isNaN(then.getTime())) return Infinity;
  const ms = now.getTime() - then.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}
```

> **日期精度说明**：Phase 1 的 `last_used_at` 用 `extractDateFromSessionId(sessionId)` 拿到的是 `YYYY-MM-DD`，精度为天。同一天多次 strong 命中会"覆盖"为相同日期，但因为 `computeDaysSince` 也按天计算，**等价于"最近一次 strong 命中是 N 天前"**，符合冷藏语义。如果未来需要更细粒度（小时级），改 `extractDateFromSessionId` 为返回 ISO 时间戳即可，向下兼容。

#### c) `src/core/governance/lint.ts`

加新问题码 `node-cold-storage-candidate`：扫所有 stable 节点，超过 `coldStorageDays` 未 strong 命中 → 报告。

#### d) `src/core/governance/govern.ts`

加新治理动作：对 `cold-storage-candidate` 节点，物理迁移 `practices/foo.md` → `incubating/practices/foo.md`，更新 frontmatter `maturity: incubating`，加 `lifecycle_history` 字段记录 `{ from: "stable", to: "incubating", reason: "cold-storage", at: <date> }`，**可逆**。

### 2.3 测试设计

**`graph-model.ts` 层（纯函数，简单）**：

- `computeDaysSince(yesterday, now) === 1`、`computeDaysSince(null) === Infinity`、`computeDaysSince("invalid") === Infinity`
- 冷藏检查：mock `last_used_at: "100 天前"` 节点 + 注入 `now` → 断言 `lifecycle_state === "cold-storage-candidate"`、`lifecycle_reasons.includes("cold-storage")`
- 边界：`last_used_at: "90 天前"` 不触发；`91 天前`触发
- 只对 stable 触发：`maturity: "incubating"` + 100 天前 last_used_at → **不**触发冷藏（incubating 还在路上）

**`govern.ts` 物理迁移层（高风险，必须充分测试）**：

- **降级路径**：构造 `practices/foo.md`（stable, 100 天前 last_used_at）→ 跑 govern → 断言：
  - `practices/foo.md` 不存在
  - `incubating/practices/foo.md` 存在
  - frontmatter `maturity: incubating`
  - frontmatter `lifecycle_history` 数组含 `{from: "stable", to: "incubating", reason: "cold-storage", at: <date>}`
- **重激活路径**：构造已降级的 `incubating/practices/foo.md`（带 lifecycle_history）→ 模拟一次 strong 命中 → graph 重建后断言 `maturity` 在 graph 节点上仍是 incubating（**重激活靠 strong_count 达到 promotionStrongThreshold，不会自动反向迁移文件**——这是有意为之，避免来回反复）
- **文件冲突保护**：构造 `practices/foo.md` 和 `incubating/practices/foo.md` 同时存在 → govern 应报错或跳过，不能盲目覆盖
- **dry-run**：govern 支持 `--dry-run`（如不支持需补），测试场景下不动文件

### 2.4 验收标准

- [ ] stable 节点 90 天未 strong 命中可触发 lint
- [ ] govern 能可逆地降级到 incubating，且不会损坏 frontmatter
- [ ] govern 支持 dry-run，能预览将降级的节点
- [ ] Phase 1 测试全过
- [ ] 新增 ~8 个 Phase 2 测试全过

### 2.5 Phase 2 Rollback

Phase 2 的物理迁移**不能简单 git revert 回滚**，因为已经迁移的文件不会自动迁回。回滚步骤：

```bash
# 1. 找出本次 govern 迁移的文件（看 lifecycle_history.at）
find .notra/incubating/practices -name "*.md" -exec grep -l "reason: cold-storage" {} +

# 2. 手动迁回（如果 .notra 在 git 里，git checkout HEAD~N -- .notra/practices/ 也能用）
git log --diff-filter=R --name-status -- .notra/  # 看 govern 重命名记录

# 3. revert 代码
git revert <phase-2-commit>
```

**建议**：Phase 2 上线前确保 `.notra/` 已纳入 git，并且 govern 写入前先 commit 一次（govern 已有的"可逆"语义包含这个假设）。

---

## Phase 3：负反馈（占位，待数据后设计）

### 启动前必须收集的数据

1. `adoption_observations.jsonl` 累积 ≥ 2 个月，可分析"agent 遵从率分布"
2. `user-memory.json` 中 `intent-mismatch` 条目积累 ≥ 10 条（当前几乎为空）
3. Phase 2 冷藏触发数 ≥ 5 个（说明系统有真实"过时"现象）

### 待定的设计决策（**现在不要预设答案**）

| 决策 | 备选 | 何时定 |
|---|---|---|
| intent-mismatch 怎么聚合到节点？ | 取 `assistantSuggestion` 关键词 vs 节点 keywords / 取 LLM 解析提到的节点 ID | Phase 1+2 数据 |
| 负信号的强度系数 | 1 条 intent-mismatch 抵 N 次 strong | 看 agent 误推荐分布 |
| 是否引入 confidence 字段 | 暂不引入，靠 `strong - negative_signals` 算分；引入则需要迁移 frontmatter | 看排序是否需要更精细 |
| 是否做 lint/govern 联动 | 类似冷藏的"长期负信号 → 降级"动作 | 看负信号是否能稳定积累 |

### 不做的事（已锁定）

- 不引入 `violated` 字段
- 不引入 `confidence *= 0.5` 这类拍脑袋衰减常数
- 不在 user-memory 之外另起负信号源（保持单源真相）

---

## 附属：一次性技术债清理

跟 Phase 1 一起做：

1. **删除 `detectLongRunningAutoTaskPattern`**（`auto-crystallize.ts:373-418`）——硬编码领域规则，应该作为某个项目的 `.notra/` 知识，而不是通用框架代码
2. **删除 `inferAdoptedNodeIds`**（`auto-crystallize.ts:295-305`）——A1 实施后已无引用
3. **审视 `preflight.ts:11-31` 的 `CHINESE_MATCH_PHRASES`**——同样是硬编码补丁，但它的去留属于检索升级（不在 A 档范围内），**Phase 1 保留**，做记录、未来 Phase（如果上 embedding）再清

---

## 执行节奏建议

| 周 | 动作 |
|---|---|
| Week 0 | Phase 1 全部改动 + 测试 + 一次性技术债清理，提 1 个 PR |
| Week 1-2 | 在自己项目上跑实际任务，观察 `adoption_observations.jsonl` |
| Week 3 | 基于观测数据评估 SKILL 文案是否需要优化，决定是否进 Phase 2 |
| Week 3-5 | Phase 2 改动 + 测试，提 1 个 PR |
| Week 5-13 | 持续观测，收集 Phase 3 所需数据 |
| Week 13+ | 基于真实数据设计 Phase 3 |

---

## 决策溯源（每个选择的来由）

> 这一节专门记录"为什么这样设计"。计划落地后回看时，这里能避免后人误解为"凭直觉拍的"。

### A1 三大设计点的决策路径

**1. 为什么 weak 信号不进晋升、只影响同 tier 排序？**

最初的方案是"strong +3、weak +1，都进 adopted_count"。但深究后发现：这只是把"+3 强化"换成"+1 强化"，本质还是单向偏置，慢一点而已——并没有真正解决"自我强化噪音"的问题。

把 weak 信号关进"只能影响同 tier 内排序、不能推进晋升"的笼子后，问题真正解决：incubating 节点必须靠 agent 显式 adopted + 代码有足迹（strong）才能晋升 stable，"仅被召回"不能推动一个节点进入主推荐池。

**2. 为什么 strong 信号要做 git 足迹校验？**

不校验就等于"agent 说啥就是啥"，把可靠性完全外包给 prompt 遵从率。审查 agent 指出：当前代码对 `adoptedNodeIds` 完全无验证，agent 乱填会直接写入 usage-index。

加 `evidence_paths ∩ touched_files` 交集校验是低成本硬性兜底——agent 说"我用了这条 practice"，但代码层完全没碰到该 practice 的证据路径，那就降为 weak 信号。能拦下大部分"agent 误标"场景。

**3. 为什么要"双重声明"（adopted 或 notApplicable 二选一必须写）？**

只写 adopted[]，agent 倾向于"心虚多填"（凡是有点像就填进去）。只写 notApplicable[]，agent 倾向于"懒得说"（不写就当默认有效）。

强制 agent 对每个 preflight 命中的节点二选一表态，会强迫它做明确的判断；同时给"缺失即 weak"的兜底，让 agent 偷懒的成本是"信号被降权"而不是"系统崩溃"。

### A2 两大设计点的决策路径

**1. 为什么 last_used_at 仅在 strong 信号时刷新？**

原方案是"preflight 命中即刷新"。审查指出这是**比当前更严重的偏置**：在任务开始时（不是结束时）就把所有被召回的节点 `last_used_at` 刷到最新，无视它是否真的被采纳。这等于保证每个被推荐过的节点永远不会"老化"，recency 衰减永远不生效。

改为"仅 strong 时刷"，语义清晰：**实际跳动才算活**——被召回但实际没采纳的节点，会自然冷却。

**2. 为什么是"冷藏开关"而不是连续衰减公式？**

`recency = 0.98^days_since_last_used` 看起来精致，但有两个问题：(a) 0.98 是拍脑袋；(b) "长期有效但低频被谈起"的架构约定（如"使用 pnpm"）会被这种连续衰减无差别压平。

冷藏开关只是"超过 90 天未 strong 命中的 stable 节点自动转 incubating"，不动连续分数公式，不伤长期有效知识，且**可逆**——被冷藏节点收到一次 strong 召回会重新激活。90 天阈值放在 `LIFECYCLE_POLICY` 可配置。

### A3 为什么整段延后？

最初的 A3 方案有三个硬伤：(a) `violated` 信号没有来源（agent 自己判定自己违背了自己用过的知识？鸡生蛋）；(b) 衰减常数 0.5 / 阈值 0.3 / decay 0.98 全是拍脑袋；(c) 与 user-memory.intent-mismatch 数据双源。

正确的做法是先靠 Phase 1+2 积累"agent 真实遵从率"和"冷藏触发频次"的数据，再基于真实分布决定负信号怎么聚合、强度怎么定。在没数据前预设常数，结果只会是"看起来精致、实际经不起几次实战"。

---

## 一句话总结

整套方案的核心哲学是 **"先建可观测的信号通路，再基于真实数据建闭环"**——而不是凭直觉一次性把 confidence/violated/0.5/0.3/0.98 这些常数全押上。Phase 1 的最大价值不是改了什么打分公式，而是给项目装了**第一个"agent 行为可观测性"采集点**（`adoption_observations.jsonl`），有了它，Phase 2/3 的所有决策都能用数据支撑。
