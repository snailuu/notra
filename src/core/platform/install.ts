import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Platform = "claude" | "codex" | "agents";
export type PlatformInput = Platform | "all";
type WriteAction = "create" | "overwrite";

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
  dryRun: boolean;
  force: boolean;
  skipExisting: boolean;
  writes: Array<{ path: string; action: WriteAction }>;
  skipped: Array<{ path: string; reason: string }>;
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

  await ensureSourcePlugin(sourcePluginRoot);

  for (const directoryName of ["scripts", "assets", "templates"]) {
    await copyTree({
      sourceRoot: path.join(sourcePluginRoot, directoryName),
      targetRoot: path.join(runtimeRoot, directoryName),
      dryRun,
      force,
      skipExisting,
      writes,
      skipped
    });
  }

  const distRoot = path.join(resolvedPackageRoot, "dist");
  const distStat = await fs.stat(distRoot).catch(() => null);
  if (!distStat?.isDirectory()) {
    throw new Error(
      `未找到构建产物 dist/: ${distRoot}。请先运行 pnpm build:ts，或确认 packageRoot 指向了包含 dist/ 的 notra 安装目录。`
    );
  }
  await copyTree({
    sourceRoot: distRoot,
    targetRoot: path.join(runtimeRoot, "dist"),
    dryRun,
    force,
    skipExisting,
    writes,
    skipped
  });

  for (const platform of selectedPlatforms) {
    const skillDirectory = path.join(resolvedProjectRoot, ...PLATFORM_SKILL_DIRECTORIES[platform]);
    await copyTree({
      sourceRoot: path.join(sourcePluginRoot, "skills"),
      targetRoot: skillDirectory,
      dryRun,
      force,
      skipExisting,
      transform: transformSkillFile,
      writes,
      skipped
    });
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
  dryRun,
  force,
  skipExisting,
  writes,
  skipped,
  transform
}: CopyTreeOptions & { sourcePath: string; targetPath: string }) {
  const rawContent = await fs.readFile(sourcePath, "utf8");
  const content = transform ? transform(rawContent, sourcePath) : rawContent;
  const existing = await fs.readFile(targetPath, "utf8").catch((error: any) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (existing === content) {
    skipped.push({ path: targetPath, reason: "unchanged" });
    return;
  }

  if (existing !== null && !force) {
    if (skipExisting) {
      skipped.push({ path: targetPath, reason: "exists" });
      return;
    }

    throw new Error(`目标文件已存在且内容不同: ${targetPath}`);
  }

  writes.push({
    path: targetPath,
    action: existing === null ? "create" : "overwrite"
  });

  if (dryRun) {
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
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
