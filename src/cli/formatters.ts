import path from "node:path";

import type { lintProjectKnowledge } from "../core/governance/lint.js";
import type { governProjectKnowledge } from "../core/governance/govern.js";
import type { buildProjectGraphArtifacts } from "../core/graph/build.js";
import type { DoctorReport } from "../core/project/doctor.js";
import type { initializeProjectKnowledge } from "../core/project/init.js";
import type { generateStatusReport } from "../core/project/status.js";
import type { autoCrystallizeSession } from "../core/session/auto-crystallize.js";
import type { crystallizeSession } from "../core/session/crystallize.js";
import type { runPreflight } from "../core/session/preflight.js";
import type { installNotraPlatforms } from "../core/platform/install.js";

type LintReport = Awaited<ReturnType<typeof lintProjectKnowledge>>;
type GovernReport = Awaited<ReturnType<typeof governProjectKnowledge>>;
type GraphArtifacts = Awaited<ReturnType<typeof buildProjectGraphArtifacts>>;
type ProjectInitResult = Awaited<ReturnType<typeof initializeProjectKnowledge>>;
type StatusReport = Awaited<ReturnType<typeof generateStatusReport>>;
type AutoCrystallizeResult = Awaited<ReturnType<typeof autoCrystallizeSession>>;
type CrystallizeResult = Awaited<ReturnType<typeof crystallizeSession>>;
type PreflightResult = Awaited<ReturnType<typeof runPreflight>>;
type PlatformInstallResult = Awaited<ReturnType<typeof installNotraPlatforms>>;

interface InitSummaryInput {
  projectRoot: string;
  platformInstall: PlatformInstallResult | null;
  projectKnowledge: ProjectInitResult | null;
  nextSteps: string[];
}

interface FinishSummaryInput {
  projectRoot: string;
  knowledgeRoot: string | null;
  crystallize: AutoCrystallizeResult;
  lint: LintReport | null;
  status: StatusReport | null;
  nextSteps: string[];
}

interface GraphJsonSummary {
  generated_at: string;
  knowledge_root: string;
  output: { data: string; index: string; html: string };
  counts_by_type: Record<string, number>;
}

export function formatInitSummary(result: InitSummaryInput): string {
  const lines = ["Notra 初始化完成", "", `项目目录: ${result.projectRoot}`];
  if (result.platformInstall) {
    const install = result.platformInstall;
    const overwritten = install.writes.filter((write) => write.action === "overwrite");
    const diverged = install.skipped.filter((skip) => skip.reason === "diverged");
    lines.push(
      `平台配置: ${install.platforms.join(", ") || "未安装"}`,
      `平台写入: ${install.writes.length}`,
      `平台跳过: ${install.skipped.length}`
    );
    // runtime 与 skill 分开报：覆盖用户地界的 skill 绝不能被算作「刷新运行时」
    const runtimeRefreshed = overwritten.filter((write) => write.scope === "runtime");
    const skillRefreshed = overwritten.filter((write) => write.scope === "skill");
    if (runtimeRefreshed.length > 0) {
      lines.push(`刷新运行时: ${runtimeRefreshed.length} 个文件`);
    }
    if (skillRefreshed.length > 0) {
      lines.push(
        `刷新 skill: ${skillRefreshed.length} 个文件`,
        ...skillRefreshed.map((write) => `- ${path.relative(result.projectRoot, write.path)}`)
      );
    }
    // 保留的文件必须逐条列出：静默跳过会让用户以为已升级到新版
    if (diverged.length > 0) {
      lines.push(
        `保留本地改动: ${diverged.length} 个文件（已确认与 notra 写入时不同；如需换成新版，加 --force）`,
        ...diverged.map((skip) => `- ${path.relative(result.projectRoot, skip.path)}`)
      );
    }
  }
  if (result.projectKnowledge) {
    const knowledge = result.projectKnowledge as ProjectInitResult & {
      knowledgeRoot?: string;
      alreadyInitialized?: boolean;
      skipped?: unknown[];
      stableNodeIds?: string[];
      incubatingNodeIds?: string[];
    };
    lines.push(
      `知识库: ${knowledge.knowledgeRoot ?? ""}`,
      knowledge.alreadyInitialized
        ? "知识库状态: 已存在，未覆盖"
        : `稳定节点: ${knowledge.stableNodeIds?.length ?? 0}`,
      knowledge.alreadyInitialized
        ? `跳过文件: ${knowledge.skipped?.length ?? 0}`
        : `孵化节点: ${knowledge.incubatingNodeIds?.length ?? 0}`
    );
  }
  if (result.platformInstall?.dryRun || (result.projectKnowledge as { dryRun?: boolean })?.dryRun) {
    lines.push("dry-run 模式未写入文件。");
  }
  lines.push("", "下一步:", ...result.nextSteps.map((step) => `- ${step}`));
  return lines.join("\n");
}

export function formatProjectInitSummary(result: ProjectInitResult): string {
  const r = result as ProjectInitResult & {
    alreadyInitialized?: boolean;
    projectRoot?: string;
    knowledgeRoot?: string;
    tech?: string[];
    stableNodeIds?: string[];
    incubatingNodeIds?: string[];
    skipped?: unknown[];
    dryRun?: boolean;
  };
  if (r.alreadyInitialized) {
    return [
      "项目知识库已存在，未覆盖。",
      `项目目录: ${r.projectRoot}`,
      `知识库: ${r.knowledgeRoot}`,
      "如需覆盖，请使用 --force；如需补齐缺失文件，请使用 --skip-existing。"
    ].join("\n");
  }

  return [
    "项目知识库初始化完成",
    `项目目录: ${r.projectRoot}`,
    `知识库: ${r.knowledgeRoot}`,
    `技术栈: ${r.tech?.join(", ") || "待补充"}`,
    `稳定节点: ${r.stableNodeIds?.length ?? 0}`,
    `孵化节点: ${r.incubatingNodeIds?.length ?? 0}`,
    r.dryRun ? "dry-run 模式未写入文件。" : ""
  ].filter(Boolean).join("\n");
}

export function formatStartSummary(result: PreflightResult): string {
  const r = result as PreflightResult & {
    mode?: string;
    projectRoot?: string;
    knowledgeRoot?: string;
    evidenceHintCount?: number;
    matchedPractices?: Array<{ title: string; id: string }>;
    recommendedOptions?: Array<{ title: string; id: string; effective_score: number }>;
  };
  if (r.mode === "no-knowledge") {
    return [
      "当前项目尚未初始化 Notra 知识库。",
      `项目目录: ${r.projectRoot}`,
      "下一步: notra init --yes"
    ].join("\n");
  }

  if (r.mode === "needs-project-scan") {
    return [
      "未命中已有知识，已返回项目扫描线索。",
      `知识库: ${r.knowledgeRoot}`,
      `Evidence hints: ${r.evidenceHintCount ?? 0}`,
      "任务完成后建议运行: notra finish \"任务总结\""
    ].join("\n");
  }

  return [
    "命中已有项目知识",
    `知识库: ${r.knowledgeRoot}`,
    `匹配实践: ${r.matchedPractices?.length ?? 0}`,
    ...(r.matchedPractices ?? []).map((item) => `- ${item.title} (${item.id})`),
    `推荐方案: ${r.recommendedOptions?.length ?? 0}`,
    ...(r.recommendedOptions ?? []).map((item) => `- ${item.title} (${item.id}) score=${item.effective_score}`),
    `Evidence hints: ${r.evidenceHintCount ?? 0}`,
    "任务完成后建议运行: notra finish \"任务总结\""
  ].join("\n");
}

export function formatFinishSummary(result: FinishSummaryInput): string {
  const crystallize = result.crystallize as AutoCrystallizeResult & {
    mode?: string;
    sessionId?: string;
    adoptedNodeIds?: string[];
    incubatingNodeIds?: string[];
    updatedNodeIds?: string[];
    auto?: { touchedFilesWarning?: { code?: string } | null };
  };
  if (crystallize.mode === "no-knowledge") {
    return [
      "未沉淀知识：当前项目尚未初始化 Notra。",
      `项目目录: ${result.projectRoot}`,
      "下一步: notra init --yes"
    ].join("\n");
  }

  const touchedFilesWarning = crystallize.auto?.touchedFilesWarning;
  return [
    "任务知识沉淀完成",
    ...(touchedFilesWarning ? [`警告: Git touched files 采集不完整 (${touchedFilesWarning.code})`] : []),
    `知识库: ${result.knowledgeRoot ?? ""}`,
    `Session: ${crystallize.sessionId ?? ""}`,
    `采纳节点: ${crystallize.adoptedNodeIds?.length ?? 0}`,
    `新增孵化节点: ${crystallize.incubatingNodeIds?.length ?? 0}`,
    `更新节点: ${crystallize.updatedNodeIds?.length ?? 0}`,
    `Lint issues: ${result.lint?.summary.issue_count ?? 0}`,
    `稳定节点: ${(result.status as { stableNodes?: number } | null)?.stableNodes ?? 0}`,
    `孵化节点: ${(result.status as { incubatingNodes?: number } | null)?.incubatingNodes ?? 0}`,
    "下一步:",
    ...result.nextSteps.map((step) => `- ${step}`)
  ].join("\n");
}

export function buildFinishNextSteps(
  crystallize: AutoCrystallizeResult,
  lint: LintReport | null,
  status: StatusReport | null
): string[] {
  const mode = (crystallize as { mode?: string }).mode;
  if (mode === "no-knowledge") {
    // 带 --yes：nextSteps 会被 agent 逐字执行，裸 notra init 在 TTY 下会停在交互提示
    return ["notra init --yes"];
  }

  const steps: string[] = [];
  if ((lint?.summary.issue_count || 0) > 0) {
    steps.push("notra lint");
  }
  if ((status as { graphDirty?: boolean } | null)?.graphDirty) {
    steps.push("notra graph");
  }
  steps.push("notra status");
  return [...new Set(steps)];
}

export function formatStatusSummary(report: StatusReport): string {
  const r = report as StatusReport & {
    projectTitle?: string;
    knowledgeRoot?: string;
    stableNodes?: number;
    incubatingNodes?: number;
    graphDirty?: boolean;
    lastGraphBuildAt?: string | null;
    recentSessions?: Array<{ title: string; id: string }>;
    recommendedOptions?: string[];
  };
  return [
    "Notra 状态",
    "",
    `项目: ${r.projectTitle ?? ""}`,
    `知识库: ${r.knowledgeRoot ?? ""}`,
    `稳定节点: ${r.stableNodes ?? 0}`,
    `孵化节点: ${r.incubatingNodes ?? 0}`,
    `Graph dirty: ${r.graphDirty ? "yes" : "no"}`,
    `最近图谱构建: ${r.lastGraphBuildAt || "无"}`,
    "最近 session:",
    ...((r.recentSessions?.length ?? 0) > 0
      ? r.recentSessions!.map((item) => `- ${item.title} (${item.id})`)
      : ["- 无"]),
    "推荐方案:",
    ...((r.recommendedOptions?.length ?? 0) > 0
      ? r.recommendedOptions!.map((item) => `- ${item}`)
      : ["- 无"])
  ].join("\n");
}

export function formatDoctorSummary(result: DoctorReport): string {
  return [
    "Notra doctor",
    "",
    `项目目录: ${result.projectRoot}`,
    `知识库: ${result.knowledgeRoot}`,
    `通过: ${result.summary.pass}  警告: ${result.summary.warn}  失败: ${result.summary.fail}`,
    "检查项:",
    ...result.checks.map((check) => `- [${check.status}] ${check.id}: ${check.message}`),
    "建议:",
    ...(result.suggestions.length > 0 ? result.suggestions.map((item) => `- ${item}`) : ["- 无"])
  ].join("\n");
}

export function formatLintSummary(report: LintReport): string {
  const r = report as LintReport & {
    knowledgeRoot?: string;
    summary: { total_nodes: number; total_edges: number; issue_count: number };
    issues: Array<{ severity: string; code: string; message: string }>;
  };
  return [
    "Notra lint",
    "",
    `知识库: ${r.knowledgeRoot ?? ""}`,
    `节点数: ${r.summary.total_nodes}`,
    `边数: ${r.summary.total_edges}`,
    `Issues: ${r.summary.issue_count}`,
    ...r.issues.slice(0, 10).map((issue) => `- [${issue.severity}] ${issue.code}: ${issue.message}`),
    r.issues.length > 10 ? `... 还有 ${r.issues.length - 10} 条` : ""
  ].filter(Boolean).join("\n");
}

export function formatGraphJson(result: GraphArtifacts): GraphJsonSummary {
  const r = result as GraphArtifacts & {
    graph: {
      generated_at: string;
      knowledge_root: string;
      stats: { counts_by_type: Record<string, number> };
    };
  };
  return {
    generated_at: r.graph.generated_at,
    knowledge_root: r.graph.knowledge_root,
    output: {
      data: "graph/graph-data.json",
      index: "graph/graph-index.json",
      html: "graph/knowledge-graph.html"
    },
    counts_by_type: r.graph.stats.counts_by_type
  };
}

export function formatGraphSummary(result: GraphJsonSummary): string {
  return [
    "图谱已生成",
    "",
    `Data: ${result.output.data}`,
    `Index: ${result.output.index}`,
    `HTML: ${result.output.html}`,
    `节点类型: ${Object.entries(result.counts_by_type).map(([type, count]) => `${type}=${count}`).join(", ")}`
  ].join("\n");
}

export function formatCrystallizeSummary(result: CrystallizeResult | AutoCrystallizeResult): string {
  const r = result as CrystallizeResult & {
    mode?: string;
    knowledgeRoot?: string;
    sessionId?: string | null;
    adoptedNodeIds?: string[];
    incubatingNodeIds?: string[];
    updatedNodeIds?: string[];
  };
  return [
    "知识结晶完成",
    `模式: ${r.mode ?? "unknown"}`,
    `知识库: ${r.knowledgeRoot ?? ""}`,
    `Session: ${r.sessionId || "无"}`,
    `采纳节点: ${r.adoptedNodeIds?.length ?? 0}`,
    `孵化节点: ${r.incubatingNodeIds?.length ?? 0}`,
    `更新节点: ${r.updatedNodeIds?.length ?? 0}`
  ].join("\n");
}

export function formatGovernSummary(result: GovernReport): string {
  const r = result as GovernReport & {
    mode?: string;
    knowledgeRoot?: string;
    action_count?: number;
    graph_rebuilt?: boolean;
    actions?: Array<{ type: string; node_id: string }>;
  };
  return [
    "知识治理完成",
    `模式: ${r.mode ?? "unknown"}`,
    `知识库: ${r.knowledgeRoot ?? ""}`,
    `动作数: ${r.action_count ?? 0}`,
    `Graph rebuilt: ${r.graph_rebuilt ? "yes" : "no"}`,
    ...(r.actions ?? []).map((action) => `- ${action.type}: ${action.node_id}`)
  ].join("\n");
}

export function formatUpdateSummary(result: Record<string, any>): string {
  const lines: string[] = ["notra update"];
  lines.push(`当前版本: ${result.currentVersion ?? "unknown"}`);
  lines.push(`目标版本: ${result.targetVersion ?? "unknown"}`);
  if (result.packageManager) {
    lines.push(`包管理器: ${result.packageManager}`);
  }
  if (result.command) {
    lines.push(`命令: ${result.command}`);
  }
  if (result.manualHint && result.mode !== "dry-run" && !result.command) {
    lines.push(`提示: ${result.manualHint}`);
  }
  lines.push("");
  lines.push(result.message ?? "");
  // 升级只换掉全局包，各项目 .notra/plugin 下的运行时副本仍是旧版
  if (result.mode === "updated") {
    lines.push("", "下一步: 在每个使用 notra 的项目里运行 notra init --yes 刷新 .notra/plugin 运行时");
  }
  return lines.join("\n");
}
