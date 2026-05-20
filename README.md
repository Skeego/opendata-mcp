# opendata-mcp

[![CI](https://github.com/skeego/opendata-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/skeego/opendata-mcp/actions/workflows/ci.yml)

A [Model Context Protocol](https://modelcontextprotocol.io/) server for the **OpenData Platform** API. Tools are generated dynamically from the bundled OpenAPI 3.1 spec — every endpoint is exposed as an MCP tool with a typed input schema and a transparent HTTP handler.

- **GET endpoints**: 76 — exposed without auth (the API serves them unauthenticated).
- **Write endpoints** (POST / PUT / PATCH / DELETE): 23 — require a Bearer token via `OPENDATA_API_KEY`.
- Built on `@modelcontextprotocol/sdk` (TypeScript) with stdio transport.

## Install

Uses [pnpm](https://pnpm.io/) (pinned via `packageManager` in `package.json` so `corepack enable` is enough to get the right version).

```bash
pnpm install
pnpm run build
```

## Configure

Copy `.env.example` → `.env` (or set in your MCP client config) and fill in:

```env
OPENDATA_BASE_URL=https://api.tryopendata.ai   # required at call time
OPENDATA_API_KEY=od_live_xxx                   # required for writes
# OPENDATA_READ_ONLY=true                      # optional: only register GET tools
# OPENDATA_TIMEOUT_MS=30000                    # optional: per-request timeout
# OPENDATA_MAX_ATTEMPTS=3                      # optional: total HTTP attempts (retries are bounded; see below)
# OPENDATA_LOG_LEVEL=info                      # optional: off|error|info|debug
```

Secrets are never read from the repo. `.env` is gitignored; `.env.example` ships placeholders only.

## Run

```bash
# Dev (tsx, no build step)
pnpm run dev

# Production (after build)
pnpm start
```

The server speaks MCP over **stdio** — wire it into any MCP-capable client. Example client config (Claude Desktop / similar):

```json
{
  "mcpServers": {
    "opendata": {
      "command": "node",
      "args": ["/absolute/path/to/opendata-mcp/dist/index.js"],
      "env": {
        "OPENDATA_BASE_URL": "https://api.tryopendata.ai",
        "OPENDATA_API_KEY": "od_live_xxx"
      }
    }
  }
}
```

## Test

```bash
pnpm test            # unit tests (mocked fetch — offline-safe)
pnpm run typecheck   # tsc --noEmit
```

Live tests against the real API run **only** when `OPENDATA_BASE_URL` is set:

```bash
OPENDATA_BASE_URL=https://api.tryopendata.ai pnpm test
```

CI runs the unit suite on every push/PR ([badge above](#opendata-mcp)). The live smoke job runs on a daily schedule (and on pushes to `main`) only if the repo has `OPENDATA_BASE_URL` (and optionally `OPENDATA_API_KEY`) configured as Actions secrets — it's `continue-on-error: true` so a transient upstream outage doesn't show the repo as red.

## How tool generation works

At startup the server:

1. Loads `openapi.json` (OpenAPI 3.1, bundled).
2. Walks every `(path, method)` pair (skipping `deprecated` operations and skipping non-GET when `OPENDATA_READ_ONLY=true`).
3. Converts each operation's path + query parameters (and JSON request body for writes) into a Zod input schema via `openapi-to-zod.ts`.
4. Registers one MCP tool per operation. The tool name is the OpenAPI `operationId` (sanitized to `[a-zA-Z0-9_-]{1,64}`); the description is `METHOD path (auth?) — summary — description`.
5. On invoke, builds the URL (substituting path params + appending the query string), attaches `Authorization: Bearer ${OPENDATA_API_KEY}` for non-GET, sends the request, and returns the response as a text MCP `content` block.

The auth contract is enforced at the client layer (`src/api-client.ts`):

- GET → no auth header is sent. If you pass a key it's still ignored.
- Non-GET → `OPENDATA_API_KEY` is required; the request fails fast with a clear error if it's missing.

## Logging, retries, and shutdown

- **Structured logging** to stderr (stdout is reserved for the MCP protocol). One JSON object per line: `{ts, level, msg, ...fields}`. Tuned via `OPENDATA_LOG_LEVEL` (`off|error|info|debug`, default `info`). Every tool invocation carries a short `rid` (request id) that also surfaces in any error message returned to the client — so a user can quote an `ERROR (rid=…)` and you can grep it in logs.
- **Bounded retries** on transient failures only: `502 / 503 / 504` and network errors are retried with jittered exponential backoff (200ms → 600ms → 1.4s, capped). `500` and any `4xx` are **never** retried — a 500 means "I tried, it broke" and retrying just hammers a server that already gave its answer; a 4xx means the request is wrong and retrying won't help. Total attempts via `OPENDATA_MAX_ATTEMPTS` (default 3).
- **Graceful shutdown** on `SIGINT` / `SIGTERM`: the MCP transport is closed before `process.exit` so any in-flight tool calls have a chance to land.

## Layout

```
src/
  index.ts              # entry — MCP server, stdio transport
  openapi-loader.ts     # loads + normalizes the bundled spec
  openapi-to-zod.ts     # OpenAPI schema → Zod schema converter
  api-client.ts         # fetch wrapper + auth contract
  tools.ts              # generates MCP tool defs from normalized ops
  __tests__/
    tools.test.ts       # unit tests (mocked fetch)
    live.test.ts        # live tests (skipped unless OPENDATA_BASE_URL set)
openapi.json            # bundled OpenAPI 3.1 spec
```

## License

MIT
