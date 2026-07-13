import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MANIFEST_RELATIVE_PATH = path.join(".notra", "plugin", ".manifest.json");

/**
 * 模拟「上一个 notra 版本装出来的项目」：把文件改回旧内容，并让 manifest 记下这份旧内容的哈希。
 * 只改文件不改 manifest 等于伪造出「用户手改过」的状态，测不到升级路径。
 */
export async function simulatePreviousInstall(projectRoot: string, relativePath: string, previousContent: string) {
  await fs.writeFile(path.join(projectRoot, relativePath), previousContent, "utf8");

  const manifestPath = path.join(projectRoot, MANIFEST_RELATIVE_PATH);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.files[relativePath] = crypto.createHash("sha256").update(previousContent).digest("hex");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

/** 模拟 manifest 出现之前的老安装（notra <= 0.2.0 装的项目里没有这个文件）。 */
export async function removeRuntimeManifest(projectRoot: string) {
  await fs.rm(path.join(projectRoot, MANIFEST_RELATIVE_PATH));
}

export async function readRuntimeManifest(projectRoot: string): Promise<{ notraVersion: string; files: Record<string, string> }> {
  return JSON.parse(await fs.readFile(path.join(projectRoot, MANIFEST_RELATIVE_PATH), "utf8"));
}
