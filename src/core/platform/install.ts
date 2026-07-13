import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Platform = "claude" | "codex" | "agents";
export type PlatformInput = Platform | "all";
type WriteAction = "create" | "overwrite";

/**
 * runtime: notra 自己 vendored 的运行时（.notra/plugin，已被 gitignore）。
 * skill:   用户地界（.claude/skills 等，与用户自有 skill 混居且通常纳入版本管理）。
 * 两者只在「没有 provenance 记录」时才需要区别对待，见 isUserEdited。
 */
type WriteScope = "runtime" | "skill";

/** 记录上次安装时 notra 写入的内容哈希，用来区分「版本陈旧」与「用户改动」。 */
const RUNTIME_MANIFEST_FILE = ".manifest.json";

export interface RuntimeTree {
  source: string;
  target: string;
}

interface InstallNotraPlatformsOptions {
  projectRoot?: string;
  packageRoot?: string;
  platforms?: PlatformInput[];
  dryRun?: boolean;
  force?: boolean;
  skipExisting?: boolean;
}

interface CopyTreeOptions {
  sourceRoot: string;
  targetRoot: string;
  projectRoot: string;
  dryRun: boolean;
  force: boolean;
  skipExisting: boolean;
  scope: WriteScope;
  manifest: Record<string, string> | null;
  nextManifest: Record<string, string>;
  writes: Array<{ path: string; action: WriteAction; scope: WriteScope }>;
  skipped: Array<{ path: string; reason: string; scope: WriteScope }>;
  transform?: (content: string, sourcePath: string) => string;
}

const SUPPORTED_PLATFORMS: Platform[] = ["claude", "codex", "agents"];

const PLATFORM_SKILL_DIRECTORIES: Record<Platform, string[]> = {
  claude: [".claude", "skills"],
  codex: [".codex", "skills"],
  agents: [".agents", "skills"]
};

export function getSupportedPlatforms(): Platform[] {
  return [...SUPPORTED_PLATFORMS];
}

export function isSupportedPlatform(platform: string): platform is Platform {
  return SUPPORTED_PLATFORMS.includes(platform as Platform);
}

const defaultPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * notra vendored 进项目的运行时由这几棵树构成。
 * install 的写入与 doctor 的陈旧检测必须读同一份清单，否则加了新树会让 doctor 静默漏报。
 */
export function resolveRuntimeTrees(packageRoot: string, runtimeRoot: string): RuntimeTree[] {
  const sourcePluginRoot = path.join(packageRoot, "plugins", "notra");
  return [
    ...["scripts", "assets", "templates"].map((name) => ({
      source: path.join(sourcePluginRoot, name),
      target: path.join(runtimeRoot, name)
    })),
    { source: path.join(packageRoot, "dist"), target: path.join(runtimeRoot, "dist") }
  ];
}

export async function installNotraPlatforms({
  projectRoot = process.cwd(),
  packageRoot = defaultPackageRoot,
  platforms = [],
  dryRun = false,
  force = false,
  skipExisting = false
}: InstallNotraPlatformsOptions = {}) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedPackageRoot = path.resolve(packageRoot);
  const selectedPlatforms = normalizePlatforms(platforms);
  const sourcePluginRoot = path.join(resolvedPackageRoot, "plugins", "notra");
  const runtimeRoot = path.join(resolvedProjectRoot, ".notra", "plugin");
  const writes: CopyTreeOptions["writes"] = [];
  const skipped: CopyTreeOptions["skipped"] = [];
  const manifest = await readRuntimeManifest(runtimeRoot);
  const nextManifest: Record<string, string> = {};

  await ensureSourcePlugin(sourcePluginRoot);

  const distRoot = path.join(resolvedPackageRoot, "dist");
  const distStat = await fs.stat(distRoot).catch(() => null);
  if (!distStat?.isDirectory()) {
    throw new Error(
      `未找到构建产物 dist/: ${distRoot}。请先运行 pnpm build:ts，或确认 packageRoot 指向了包含 dist/ 的 notra 安装目录。`
    );
  }

  for (const tree of resolveRuntimeTrees(resolvedPackageRoot, runtimeRoot)) {
    await copyTree({
      sourceRoot: tree.source,
      targetRoot: tree.target,
      projectRoot: resolvedProjectRoot,
      dryRun,
      force,
      skipExisting,
      scope: "runtime",
      manifest,
      nextManifest,
      writes,
      skipped
    });
  }

  for (const platform of selectedPlatforms) {
    const skillDirectory = path.join(resolvedProjectRoot, ...PLATFORM_SKILL_DIRECTORIES[platform]);
    await copyTree({
      sourceRoot: path.join(sourcePluginRoot, "skills"),
      targetRoot: skillDirectory,
      projectRoot: resolvedProjectRoot,
      dryRun,
      force,
      skipExisting,
      scope: "skill",
      manifest,
      nextManifest,
      transform: transformSkillFile,
      writes,
      skipped
    });
  }

  if (!dryRun) {
    await writeRuntimeManifest(runtimeRoot, resolvedPackageRoot, nextManifest);
  }

  return {
    projectRoot: resolvedProjectRoot,
    packageRoot: resolvedPackageRoot,
    platforms: selectedPlatforms,
    dryRun,
    writes,
    skipped
  };
}

/**
 * 缺失是合法状态（0.2.0 及更早装的项目没有它），返回 null 让判定退回按 scope 猜。
 * 但损坏不是——静默退回会让用户对 runtime 的改动被当成陈旧副本无声覆盖，所以必须报错。
 */
export async function readRuntimeManifest(runtimeRoot: string): Promise<Record<string, string> | null> {
  const manifestPath = path.join(runtimeRoot, RUNTIME_MANIFEST_FILE);
  const raw = await fs.readFile(manifestPath, "utf8").catch((error: any) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (raw === null) {
    return null;
  }

  const files = parseManifestFiles(raw);
  if (files === null) {
    throw new Error(`运行时清单已损坏: ${manifestPath}。删除该文件后重跑 notra init --yes 即可重建。`);
  }
  return files;
}

function parseManifestFiles(raw: string): Record<string, string> | null {
  try {
    const files = JSON.parse(raw)?.files;
    return files && typeof files === "object" && !Array.isArray(files) ? files : null;
  } catch {
    return null;
  }
}

async function writeRuntimeManifest(runtimeRoot: string, packageRoot: string, files: Record<string, string>) {
  const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  const manifest = { notraVersion: packageJson.version, files };
  await fs.mkdir(runtimeRoot, { recursive: true });
  await fs.writeFile(path.join(runtimeRoot, RUNTIME_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function normalizePlatforms(platforms: PlatformInput[] = []): Platform[] {
  const selected = platforms.includes("all") ? SUPPORTED_PLATFORMS : platforms;
  const normalized = [...new Set(selected)] as Platform[];

  if (normalized.length === 0) {
    return ["agents"];
  }

  for (const platform of normalized) {
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      throw new Error(`不支持的平台: ${platform}`);
    }
  }

  return normalized;
}

async function ensureSourcePlugin(sourcePluginRoot: string) {
  const stat = await fs.stat(sourcePluginRoot).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`未找到 notra 插件资源目录: ${sourcePluginRoot}`);
  }
}

async function copyTree(options: CopyTreeOptions) {
  const entries = await fs.readdir(options.sourceRoot, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(options.sourceRoot, entry.name);
    const targetPath = path.join(options.targetRoot, entry.name);

    if (entry.isDirectory()) {
      await copyTree({
        ...options,
        sourceRoot: sourcePath,
        targetRoot: targetPath
      });
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    await copyFile({
      ...options,
      sourcePath,
      targetPath
    });
  }
}

async function copyFile({
  sourcePath,
  targetPath,
  projectRoot,
  dryRun,
  force,
  skipExisting,
  scope,
  manifest,
  nextManifest,
  writes,
  skipped,
  transform
}: CopyTreeOptions & { sourcePath: string; targetPath: string }) {
  const rawContent = await fs.readFile(sourcePath, "utf8");
  const content = transform ? transform(rawContent, sourcePath) : rawContent;
  const relativePath = path.relative(projectRoot, targetPath);

  // 没写这个文件时必须沿用上次的记录：谎称写了新版会让磁盘上的旧内容在下次被误判成用户改动。
  // 注意不能改记 existing 的哈希——那会让用户的改动在下次被认作 notra 自己的文件而遭覆盖。
  const keepPreviousRecord = () => {
    const recorded = manifest?.[relativePath];
    if (recorded !== undefined) {
      nextManifest[relativePath] = recorded;
    }
  };

  const existing = await fs.readFile(targetPath, "utf8").catch((error: any) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (existing === content) {
    nextManifest[relativePath] = hashContent(content);
    skipped.push({ path: targetPath, reason: "unchanged", scope });
    return;
  }

  if (existing !== null && !force) {
    // --skip-existing 是调用方的显式意图，任何情况下都让它赢
    if (skipExisting) {
      keepPreviousRecord();
      skipped.push({ path: targetPath, reason: "exists", scope });
      return;
    }

    if (isUserEdited(existing, relativePath, manifest, scope)) {
      keepPreviousRecord();
      skipped.push({ path: targetPath, reason: "diverged", scope });
      return;
    }
  }

  writes.push({
    path: targetPath,
    action: existing === null ? "create" : "overwrite",
    scope
  });

  if (dryRun) {
    keepPreviousRecord();
    return;
  }

  // 记录 notra 本次实际写入的内容，供下次安装区分陈旧与用户改动
  nextManifest[relativePath] = hashContent(content);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
}

/**
 * 磁盘上的文件与新版源不同，可能是「notra 上次写入后自己升级了」，也可能是「用户改过」。
 * manifest 记着上次写入时的内容哈希：命中说明这份文件仍是 notra 留下的，可安全刷新。
 * 没有 manifest（老版本装的）时只能按地界猜：runtime 是 vendored 产物，刷新；skill 在用户地界，保留。
 *
 * doctor 必须复用它：否则 doctor 判「陈旧」而 install 判「用户改动」拒绝刷新，
 * 会让 doctor 一直 warn、按它的建议跑 init 又毫无效果。
 */
export function isUserEdited(
  existing: string,
  relativePath: string,
  manifest: Record<string, string> | null,
  scope: WriteScope
): boolean {
  const recorded = manifest?.[relativePath];
  if (recorded !== undefined) {
    return hashContent(existing) !== recorded;
  }
  return scope === "skill";
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function transformSkillFile(content: string, sourcePath: string): string {
  if (path.basename(sourcePath) !== "SKILL.md") {
    return content;
  }

  return content.replace(
    /- Resolve `\.\.\/\.\.\/scripts\/([^`]+)`[^\n]*/g,
    "- Run `node .notra/plugin/scripts/$1` from the target project root."
  );
}
