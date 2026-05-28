import path from "node:path";

export const VALID_NODE_TYPES = new Set(["practice", "option", "context", "constraint", "rule"]);
export const NODE_ID_PATTERN = /^[a-zA-Z0-9一-鿿][a-zA-Z0-9一-鿿_.-]*$/;
export const SESSION_ID_PATTERN = /^[a-zA-Z0-9一-鿿][a-zA-Z0-9一-鿿_.-]*$/;

export interface KnowledgeNodeRef {
  id: string;
  type: string;
  maturity?: string;
}

export function validateNodeId(nodeId: unknown): string {
  const value = String(nodeId || "").trim();
  if (!NODE_ID_PATTERN.test(value)) {
    throw new Error(`非法 nodeId: ${nodeId}`);
  }
  return value;
}

export function validateNodeType(type: unknown): string {
  const value = String(type || "").trim();
  if (!VALID_NODE_TYPES.has(value)) {
    throw new Error(`非法节点类型: ${type}`);
  }
  return value;
}

export function validateSessionId(sessionId: unknown): string {
  const value = String(sessionId || "").trim();
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new Error(`非法 sessionId: ${sessionId}`);
  }
  return value;
}

export function assertInsideKnowledgeRoot(knowledgeRoot: string, candidatePath: string): string {
  const resolvedRoot = path.resolve(knowledgeRoot);
  const resolvedCandidate = path.resolve(candidatePath);
  const relativePath = path.relative(resolvedRoot, resolvedCandidate);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`路径越界: ${candidatePath}`);
  }
  return resolvedCandidate;
}

export function resolveNodePath(knowledgeRoot: string, node: KnowledgeNodeRef): string {
  const safeNodeId = validateNodeId(node.id);
  const safeType = validateNodeType(node.type);
  const baseDirectory =
    node.maturity === "incubating"
      ? path.join(knowledgeRoot, "incubating", `${safeType}s`)
      : path.join(knowledgeRoot, `${safeType}s`);
  return assertInsideKnowledgeRoot(knowledgeRoot, path.join(baseDirectory, `${safeNodeId}.md`));
}
