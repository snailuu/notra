#!/usr/bin/env node

import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rejectKnowledgeNode } from "../core/governance/govern.js";

const currentFilePath = fileURLToPath(import.meta.url);
const port = Number(process.argv[3] || process.env.PORT || 8124);
const MAX_JSON_REQUEST_BYTES = 64 * 1024;

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

export function createProjectKnowledgeServer(projectRoot: string) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const knowledgeRoot = path.join(resolvedProjectRoot, ".notra");
  const governanceToken = crypto.randomUUID();

  return http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(
        request.url || "/",
        `http://${request.headers.host || "127.0.0.1"}`
      );

      if (requestUrl.pathname === "/api/governance/session") {
        handleGovernanceSession(request, response, governanceToken);
        return;
      }

      if (requestUrl.pathname === "/api/governance/reject") {
        await handleGovernanceReject(request, response, resolvedProjectRoot, governanceToken);
        return;
      }

      const relativePath =
        requestUrl.pathname === "/"
          ? "/graph/knowledge-graph.html"
          : requestUrl.pathname;
      const safePath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
      const absolutePath = path.resolve(knowledgeRoot, safePath);

      if (!isInsideDirectory(knowledgeRoot, absolutePath)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
      }

      const buffer = await fs.readFile(absolutePath);
      response.writeHead(200, { "content-type": resolveMimeType(absolutePath) });
      response.end(buffer);
    } catch (error: any) {
      const statusCode = error.code === "ENOENT" ? 404 : 500;
      response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
      response.end(statusCode === 404 ? "Not Found" : String(error.message || error));
    }
  });
}

function handleGovernanceSession(request: IncomingMessage, response: ServerResponse, governanceToken: string) {
  if (request.method !== "GET") {
    writeJson(response, 405, { ok: false, error: "method-not-allowed" });
    return;
  }

  writeJson(response, 200, { ok: true, governanceToken });
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
      error: String(error.message || error)
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
  return source ? JSON.parse(source) : {};
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function isAllowedSameOriginRequest(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  const host = request.headers.host || "127.0.0.1";
  return origin === `http://${host}`;
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
  server.listen(port, "127.0.0.1", () => {
    console.log(
      `Project knowledge preview: http://127.0.0.1:${port}/graph/knowledge-graph.html`
    );
  });
}
