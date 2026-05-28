#!/usr/bin/env node

import fs from "node:fs/promises";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rejectKnowledgeNode } from "../core/governance/govern.js";

const currentFilePath = fileURLToPath(import.meta.url);
const port = Number(process.argv[3] || process.env.PORT || 8124);
const MAX_JSON_REQUEST_BYTES = 64 * 1024;
const DEFAULT_HOST = "127.0.0.1";
const ALLOWED_HOSTS = new Set([DEFAULT_HOST, "localhost", "::1"]);

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

function resolveMimeType(filePath: string): string {
  return mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

export interface ProjectKnowledgeServer extends Server {
  listenLocal(serverPort: number, callback?: () => void): Server;
}

export function createProjectKnowledgeServer(projectRoot: string): ProjectKnowledgeServer {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const knowledgeRoot = path.join(resolvedProjectRoot, ".notra");
  const governanceToken = crypto.randomUUID();

  const server = http.createServer(async (request, response) => {
    try {
      if (!isAllowedHost(request)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Forbidden host");
        return;
      }

      const requestUrl = new URL(
        request.url || "/",
        `http://${DEFAULT_HOST}`
      );

      if (requestUrl.pathname === "/api/governance/reject") {
        await handleGovernanceReject(request, response, resolvedProjectRoot, governanceToken);
        return;
      }

      const relativePath =
        requestUrl.pathname === "/"
          ? "/graph/knowledge-graph.html"
          : requestUrl.pathname;
      const safePath = path.normalize(relativePath).replace(/^[/\\]+/, "").replace(/^(\.\.[/\\])+/, "");
      const absolutePath = path.resolve(knowledgeRoot, safePath);

      if (!isInsideDirectory(knowledgeRoot, absolutePath)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
      }

      const buffer = await fs.readFile(absolutePath);
      const mimeType = resolveMimeType(absolutePath);

      if (mimeType.startsWith("text/html")) {
        const html = buffer.toString("utf8");
        response.writeHead(200, { "content-type": mimeType, "cache-control": "no-store" });
        response.end(injectGovernanceToken(html, governanceToken));
        return;
      }

      response.writeHead(200, { "content-type": mimeType });
      response.end(buffer);
    } catch (error: any) {
      const statusCode = error.code === "ENOENT" ? 404 : 500;
      response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
      response.end(statusCode === 404 ? "Not Found" : "Internal Server Error");
    }
  }) as ProjectKnowledgeServer;

  server.listenLocal = (serverPort: number, callback?: () => void) => server.listen(serverPort, DEFAULT_HOST, callback);
  return server;
}

async function handleGovernanceReject(
  request: IncomingMessage,
  response: ServerResponse,
  projectRoot: string,
  governanceToken: string
) {
  if (request.method !== "POST") {
    writeJson(response, 405, { ok: false, error: "method-not-allowed" });
    return;
  }

  if (!isAllowedSameOriginRequest(request)) {
    writeJson(response, 403, { ok: false, error: "forbidden-origin" });
    return;
  }

  if (request.headers["x-notra-governance-token"] !== governanceToken) {
    writeJson(response, 403, { ok: false, error: "invalid-governance-token" });
    return;
  }

  try {
    const body = await readJsonRequest(request);
    const action = await rejectKnowledgeNode(projectRoot, {
      nodeId: body.nodeId,
      reason: body.reason || "manual-reject"
    });
    writeJson(response, 200, { ok: true, action });
  } catch (error: any) {
    writeJson(response, error.statusCode || 400, {
      ok: false,
      error: error instanceof RequestError ? error.message : "bad-request"
    });
  }
}

async function readJsonRequest(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_JSON_REQUEST_BYTES) {
      throw new RequestError(413, "request-body-too-large");
    }
    chunks.push(chunk);
  }
  const source = Buffer.concat(chunks).toString("utf8").trim();
  if (!source) {
    return {};
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new RequestError(400, "invalid-json");
  }
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function isAllowedHost(request: IncomingMessage): boolean {
  const hostHeader = (request.headers.host || "").toLowerCase();
  if (!hostHeader) {
    return false;
  }
  // IPv6 字面值 [::1]:port 形式
  if (hostHeader.startsWith("[")) {
    const closing = hostHeader.indexOf("]");
    if (closing === -1) {
      return false;
    }
    return ALLOWED_HOSTS.has(hostHeader.slice(1, closing));
  }
  const hostName = hostHeader.split(":")[0] || "";
  return ALLOWED_HOSTS.has(hostName);
}

function isAllowedSameOriginRequest(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) {
    // Origin 头由浏览器在跨域时强制添加，缺失通常意味着 CLI/Node 内部调用。
    // DNS rebinding 由 isAllowedHost 拦截（Host 必须是 127.0.0.1/localhost）。
    return true;
  }
  const host = request.headers.host;
  if (!host) {
    return false;
  }
  return origin === `http://${host}`;
}

function injectGovernanceToken(html: string, token: string): string {
  const escapedToken = token.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const meta = `<meta name="x-notra-governance-token" content="${escapedToken}">`;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `  ${meta}\n</head>`);
  }
  return `${meta}\n${html}`;
}

function isInsideDirectory(rootDirectory: string, candidatePath: string): boolean {
  const relativePath = path.relative(path.resolve(rootDirectory), path.resolve(candidatePath));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

class RequestError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFilePath)) {
  const projectRoot = path.resolve(process.argv[2] || process.cwd());
  const server = createProjectKnowledgeServer(projectRoot);
  server.listenLocal(port, () => {
    console.log(
      `Project knowledge preview: http://${DEFAULT_HOST}:${port}/graph/knowledge-graph.html`
    );
  });
}
