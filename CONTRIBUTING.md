# 贡献指南

感谢你愿意维护 Notra。这个仓库采用 Node.js ESM + TypeScript，主源码位于 `src/`，测试位于 `tests/` 与 `knowledge/tests/`。

## 开发环境

- Node.js 24
- pnpm 10.14.0

首次安装依赖：

```bash
pnpm install
```

## 本地质量门禁

提交变更前请运行：

```bash
pnpm run check
```

该命令会执行：

- `pnpm typecheck`：构建并检查源码与测试类型
- `pnpm test`：运行 Node 测试套件
- `pnpm audit:security`：通过 npm 官方 registry 执行依赖安全审计

## 代码规范

- 新增业务源码优先放入 `src/`，避免继续扩展旧的兼容脚本。
- 测试文件使用 `.test.ts`，共享测试辅助文件使用 `.ts`。
- CLI 兼容入口 `bin/notra.mjs` 保持为薄包装，真实逻辑应放在 `src/bin/notra.ts` 或对应核心模块中。
- 插件和历史脚本中的 `.mjs` 仍属于分发兼容边界，修改前需要确认不会破坏已安装插件。
- 新功能应补充覆盖关键行为的测试，并确保 `pnpm run check` 通过。

## Pull Request 要求

- PR 应描述问题背景、核心变更和验证方式。
- 涉及用户可见行为时，请补充测试或说明无法自动化覆盖的原因。
- CI 必须通过类型检查、单元测试和安全审计后再合并。
