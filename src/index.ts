#!/usr/bin/env node
/**
 * OpenData Platform MCP server (stdio transport).
 *
 * Tools are generated dynamically from the bundled OpenAPI 3.1 spec
 * (`openapi.json`). GET endpoints are exposed without auth; non-GET
 * endpoints require `OPENDATA_API_KEY` in the environment.
 *
 * Config (env vars):
 *   OPENDATA_BASE_URL    Required at call time. The API base URL (no trailing slash).
 *   OPENDATA_API_KEY     Required for non-GET tools. Bearer token.
 *   OPENDATA_READ_ONLY   Optional. "true" → only register GET tools.
 *   OPENDATA_TIMEOUT_MS  Optional. Per-request timeout (default 30000).
 *   OPENDATA_MAX_ATTEMPTS Optional. Total HTTP attempts incl. initial (default 3).
 *   OPENDATA_LOG_LEVEL   Optional. off | error | info | debug (default info).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadBundledSpec, normalize } from "./openapi-loader.js";
import { buildTools } from "./tools.js";
import type { ClientConfig } from "./api-client.js";
import { configureLogger, log } from "./logger.js";

const VERSION = "0.2.0";

function readConfig(): ClientConfig & { readOnly: boolean } {
  return {
    baseUrl: process.env.OPENDATA_BASE_URL?.replace(/\/+$/, "") || undefined,
    apiKey: process.env.OPENDATA_API_KEY || undefined,
    timeoutMs: Number(process.env.OPENDATA_TIMEOUT_MS) || 30_000,
    maxAttempts: Number(process.env.OPENDATA_MAX_ATTEMPTS) || 3,
    readOnly: (process.env.OPENDATA_READ_ONLY || "").toLowerCase() === "true",
  };
}

async function main(): Promise<void> {
  configureLogger(process.env.OPENDATA_LOG_LEVEL);
  const cfg = readConfig();
  const spec = loadBundledSpec();
  const ops = normalize(spec);
  const tools = buildTools(spec, ops, { readOnly: cfg.readOnly });

  const server = new McpServer({ name: "opendata-mcp", version: VERSION });

  for (const t of tools) {
    server.tool(t.name, t.description, t.inputShape, async (args: Record<string, unknown>) => {
      return await t.invoke(args, cfg);
    });
  }

  const writes = tools.filter((t) => t.method !== "get").length;
  const reads = tools.length - writes;
  log.info("server.start", {
    version: VERSION,
    tools: tools.length,
    reads, writes,
    readOnly: cfg.readOnly,
    baseUrl: cfg.baseUrl ?? null,
    apiKeyConfigured: !!cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
    maxAttempts: cfg.maxAttempts ?? 3,
  });
  if (!cfg.baseUrl) {
    log.error("server.config_warning", {
      message: "OPENDATA_BASE_URL is not set — tool calls will fail until configured",
    });
  }

  const transport = new StdioServerTransport();

  // Graceful shutdown: drain the SDK transport on signals so any in-flight
  // tool calls have a chance to land before the process exits.
  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("server.shutdown", { signal: sig });
    try { await server.close(); } catch (err) { log.error("server.shutdown_error", { message: (err as Error).message }); }
    process.exit(0);
  };
  process.on("SIGINT",  () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
}

main().catch((err) => {
  log.error("server.fatal", { message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exit(1);
});
