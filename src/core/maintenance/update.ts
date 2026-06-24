import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const NOTRA_PACKAGE_NAME = "@snailuu/notra";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export interface UpdateOptions {
  target?: string;
  dryRun?: boolean;
  packageManager?: PackageManager;
  packageRoot: string;
  registryUrl?: string;
  fetchImpl?: typeof fetch;
}

export type UpdateMode = "no-op" | "updated" | "dry-run" | "manual-fallback";

export interface UpdateResult {
  mode: UpdateMode;
  currentVersion: string;
  targetVersion: string;
  packageManager: PackageManager | null;
  command: string | null;
  manualHint: string | null;
  message: string;
}

export async function runUpdate(options: UpdateOptions): Promise<UpdateResult> {
  const target = options.target || "latest";
  const currentVersion = await readCurrentVersion(options.packageRoot);
  const targetVersion = await resolveTargetVersion(target, options);

  if (targetVersion === currentVersion) {
    return {
      mode: "no-op",
      currentVersion,
      targetVersion,
      packageManager: null,
      command: null,
      manualHint: null,
      message: `已是最新版本 ${currentVersion}`
    };
  }

  const packageManager = options.packageManager || (await detectPackageManager());
  const command = buildInstallCommand(packageManager, targetVersion);

  if (options.dryRun) {
    return {
      mode: "dry-run",
      currentVersion,
      targetVersion,
      packageManager,
      command,
      manualHint: command,
      message: command
        ? `[dry-run] 将执行: ${command}`
        : `[dry-run] 未检测到包管理器，请手动执行: pnpm i -g ${NOTRA_PACKAGE_NAME}@${targetVersion}`
    };
  }

  if (!packageManager) {
    const hint = `pnpm i -g ${NOTRA_PACKAGE_NAME}@${targetVersion}`;
    return {
      mode: "manual-fallback",
      currentVersion,
      targetVersion,
      packageManager: null,
      command: null,
      manualHint: hint,
      message: `未检测到包管理器（pnpm/npm/yarn/bun），请手动执行: ${hint}`
    };
  }

  try {
    await spawnInstall(packageManager, targetVersion);
    return {
      mode: "updated",
      currentVersion,
      targetVersion,
      packageManager,
      command,
      manualHint: null,
      message: `已更新 ${currentVersion} → ${targetVersion}（${packageManager}）`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: "manual-fallback",
      currentVersion,
      targetVersion,
      packageManager,
      command,
      manualHint: command,
      message: `${packageManager} 自动更新失败 (${message})，请手动执行: ${command}`
    };
  }
}

export async function readCurrentVersion(packageRoot: string): Promise<string> {
  const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  return String(pkg.version || "");
}

export async function resolveTargetVersion(target: string, options: Pick<UpdateOptions, "registryUrl" | "fetchImpl"> = {}): Promise<string> {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new Error("更新目标不能为空");
  }
  if (trimmed === "latest" || trimmed === "stable") {
    return await fetchLatestVersion(options);
  }
  if (/^\d+\.\d+\.\d+([+\-.][\w.+-]+)?$/.test(trimmed)) {
    return trimmed;
  }
  throw new Error(`无效的更新目标: ${target}（支持 latest/stable 或 x.y.z 版本号）`);
}

async function fetchLatestVersion(options: Pick<UpdateOptions, "registryUrl" | "fetchImpl">): Promise<string> {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("当前 Node 运行时缺少全局 fetch；请升级到 Node 18+ 或传入 fetchImpl");
  }
  const baseUrl = options.registryUrl || "https://registry.npmjs.org";
  const url = `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(NOTRA_PACKAGE_NAME)}/latest`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`registry HTTP ${response.status}`);
    }
    const data = await response.json() as { version?: string };
    if (!data?.version) {
      throw new Error("registry 响应缺少 version 字段");
    }
    return data.version;
  } finally {
    clearTimeout(timeout);
  }
}

export async function detectPackageManager(): Promise<PackageManager | null> {
  for (const candidate of ["pnpm", "npm", "yarn", "bun"] as PackageManager[]) {
    if (await hasCommand(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function hasCommand(command: string): Promise<boolean> {
  const lookup = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(lookup, [command], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

export function buildInstallCommand(packageManager: PackageManager | null, version: string): string | null {
  if (!packageManager) {
    return null;
  }
  const args = buildInstallArgs(packageManager, version);
  return [packageManager, ...args].join(" ");
}

export function buildInstallArgs(packageManager: PackageManager, version: string): string[] {
  const target = `${NOTRA_PACKAGE_NAME}@${version}`;
  switch (packageManager) {
    case "pnpm":
      return ["add", "-g", target];
    case "npm":
      return ["i", "-g", target];
    case "yarn":
      return ["global", "add", target];
    case "bun":
      return ["add", "-g", target];
  }
}

async function spawnInstall(packageManager: PackageManager, version: string): Promise<void> {
  const args = buildInstallArgs(packageManager, version);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(packageManager, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${packageManager} 退出码 ${code}`));
      }
    });
  });
}
