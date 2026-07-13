# AGENTS.md

Notra 是一个把项目知识沉淀成图谱的 CLI（`notra`），本仓库是它的源码。

## 开发命令

```bash
pnpm build:ts     # 必须先构建：测试从 dist/ 导入，不是从 src/
pnpm test         # node:test，扁平 test(name, fn)，无 describe/it
pnpm typecheck
pnpm check        # typecheck + test + audit
```

跑单个测试文件：

```bash
pnpm build:ts && node --experimental-test-isolation=none --test tests/init.test.ts
```

`tests/` 是扁平结构，不镜像 `src/`。新增 `src/cli/foo.ts` 对应 `tests/foo.test.ts`，从 `../dist/cli/foo.js` 导入。

## 调用 notra CLI 的约定

**非交互场景一律加 `--yes`。** 裸 `notra init` 在 TTY 下会停在平台多选提示等待按键；没有真人时会一直等下去。`--yes`、`--json`、`--no-interactive` 任一都会关闭交互并取安全默认值（平台 `agents`、初始化知识库）。

```bash
notra init --yes                 # 幂等：可在升级后重复运行以刷新运行时
notra start "任务描述"            # 任务开始前取项目知识建议
notra finish "任务总结"           # 任务结束后沉淀知识
notra doctor --json              # 体检；--strict 让存在失败项时退出码非零
```

`--json` 输出机器可读结果到 stdout，并隐含关闭交互。

**不要**为了绕过冲突而加 `--force`：它对知识库是破坏性的，会重置 `project-profile.md` 的手写内容、`state/runtime-state.json` 的会话游标和 `state/usage-index.json` 的使用统计。要保留已有文件用 `--skip-existing`。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功。**包括各种 no-op**；`doctor` 不带 `--strict` 时即使有失败项也返回 0 |
| 1 | 运行失败、`doctor --strict` 存在失败项、`update` 回退到手动模式 |
| 2 | 未知命令、未知参数、非法 `--pm` 取值 |

失败时错误只写到 stderr，**stdout 不会有 JSON**（即便传了 `--json`）。要判断成败请看退出码，不要依赖 payload 里的 `ok` 字段——只有 `init` / `finish` / `doctor` 有该字段。

## init 如何区分「版本陈旧」与「用户改动」（改 `src/core/platform/install.ts` 前必读）

`notra init` 会往项目写两类内容：`.notra/plugin/` 是 vendored 运行时（gitignored，语义等同 `node_modules`），`.claude|.codex|.agents/skills/` 是用户地界（通常纳入版本管理、与用户自有 skill 混居）。

每次安装会在 `.notra/plugin/.manifest.json` 记下 notra 写入的每个文件的 sha256（`writeRuntimeManifest`）。重装时 `isUserEdited` 据此判断磁盘上与新版不同的文件：

- **哈希命中 manifest** → 仍是 notra 上次留下的，是版本陈旧 → 刷新。
- **哈希对不上** → 用户真改过 → 保留并逐条汇报（`reason: "diverged"`），只有 `--force` 才覆盖。
- **manifest 缺失**（0.2.0 及更早装的老项目）→ 无从判断，按地界回退：runtime 刷新、skill 保守保留。老项目第一次重装后 manifest 补齐，之后即精确。

这让 skills 也能随版本升级（不再永远停在旧版），同时不会静默吞掉用户的编辑。

`notra update` 只升级全局 npm 包，**不会**刷新各项目里的 `.notra/plugin/`。升级后需要在每个项目重跑 `notra init --yes`；`notra doctor` 的 `runtime-freshness` 检查会发现陈旧的运行时（逐文件比对，含 `dist/`）。
