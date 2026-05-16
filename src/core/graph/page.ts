// @ts-nocheck -- 第一阶段保守迁移：业务脚本保持行为等价，CLI 边界先类型化。
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, "..", "..", "..");
const assetDirectory = path.resolve(packageRoot, "assets", "graph");

export async function buildProjectGraphPage(projectKnowledgeDir) {
  const graphDirectory = path.join(projectKnowledgeDir, "graph");

  await fs.mkdir(graphDirectory, { recursive: true });
  await fs.cp(assetDirectory, graphDirectory, { force: true, recursive: true });

  return {
    html: path.join(graphDirectory, "knowledge-graph.html"),
    css: path.join(graphDirectory, "knowledge-graph.css"),
    js: path.join(graphDirectory, "knowledge-graph.js"),
    runtime: path.join(graphDirectory, "graph-runtime.js")
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectKnowledgeDir = path.resolve(process.argv[2] || ".notra");
  const output = await buildProjectGraphPage(projectKnowledgeDir);
  console.log(JSON.stringify(output, null, 2));
}
