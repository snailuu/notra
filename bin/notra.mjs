#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(currentFilePath), "..");
const builtCliPath = path.join(packageRoot, "dist", "bin", "notra.js");

try {
  await fs.access(builtCliPath);
} catch {
  console.error("源码开发环境未找到构建后的 CLI，请先运行: pnpm build:ts");
  process.exitCode = 1;
  process.exit();
}

await import(pathToFileURL(builtCliPath).href);
