#!/usr/bin/env node
/**
 * OpenData Platform MCP server (stdio transport).
 *
 * Tools are generated dynamically from the bundled OpenAPI 3.1 spec
 * (`openapi.json`). GET endpoints are exposed without auth; non-GET
 * endpoints require `OPENDATA_API_KEY` in the environment.
 *
 * Config (env vars):
 *   OPENDATA_BASE_URL   Required at call time. The API base URL (no trailing slash).
 *   OPENDATA_API_KEY    Required for non-GET tools. Bearer token.
 *   OPENDATA_READ_ONLY  Optional. "true" → only register GET tools.
 *   OPENDATA_TIMEOUT_MS Optional. Per-request timeout (default 30000).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadBundledSpec, normalize } from "./openapi-loader.js";
import { buildTools } from "./tools.js";
import type { ClientConfig } from "./api-client.js";

function readConfig(): ClientConfig & { readOnly: boolean } {
  return {
    baseUrl: process.env.OPENDATA_BASE_URL?.replace(/\/+$/, "") || undefined,
    apiKey: process.env.OPENDATA_API_KEY || undefined,
    timeoutMs: Number(process.env.OPENDATA_TIMEOUT_MS) || 30_000,
    readOnly: (process.env.OPENDATA_READ_ONLY || "").toLowerCase() === "true",
  };
}

async function main(): Promise<void> {
  const cfg = readConfig();
  const spec = loadBundledSpec();
  const ops = normalize(spec);
  const tools = buildTools(spec, ops, { readOnly: cfg.readOnly });

  const server = new McpServer({
    name: "opendata-mcp",
    version: "0.1.0",
  });

  for (const t of tools) {
    server.tool(t.name, t.description, t.inputShape, async (args: Record<string, unknown>) => {
      return await t.invoke(args, cfg);
    });
  }

  // Helpful diagnostics on stderr (does not interfere with stdio protocol on stdout).
  const writes = tools.filter((t) => t.method !== "get").length;
  const reads = tools.length - writes;
  process.stderr.write(
    `opendata-mcp: registered ${tools.length} tools (${reads} GET, ${writes} write) ` +
      `${cfg.readOnly ? "[read-only mode] " : ""}` +
      `baseUrl=${cfg.baseUrl ?? "UNSET"} apiKey=${cfg.apiKey ? "set" : "UNSET"}\n`,
  );
  if (!cfg.baseUrl) {
    process.stderr.write(
      "WARNING: OPENDATA_BASE_URL is not set — tool calls will fail until configured.\n",
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`opendata-mcp fatal: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
