# opendata-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server for the **OpenData Platform** API. Tools are generated dynamically from the bundled OpenAPI 3.1 spec — every endpoint is exposed as an MCP tool with a typed input schema and a transparent HTTP handler.

- **GET endpoints**: 76 — exposed without auth (the API serves them unauthenticated).
- **Write endpoints** (POST / PUT / PATCH / DELETE): 23 — require a Bearer token via `OPENDATA_API_KEY`.
- Built on `@modelcontextprotocol/sdk` (TypeScript) with stdio transport.

## Install

```bash
npm install
npm run build
```

## Configure

Copy `.env.example` → `.env` (or set in your MCP client config) and fill in:

```env
OPENDATA_BASE_URL=https://api.tryopendata.ai   # required at call time
OPENDATA_API_KEY=od_live_xxx                         # required for writes
# OPENDATA_READ_ONLY=true                            # optional: only register GET tools
# OPENDATA_TIMEOUT_MS=30000                          # optional: per-request timeout
```

Secrets are never read from the repo. `.env` is gitignored; `.env.example` ships placeholders only.

## Run

```bash
# Dev (tsx, no build step)
npm run dev

# Production (after build)
npm start
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
npm test            # unit tests (mocked fetch — offline-safe)
npm run typecheck   # tsc --noEmit
```

Live tests against the real API run **only** when `OPENDATA_BASE_URL` is set:

```bash
OPENDATA_BASE_URL=https://api.tryopendata.ai npm test
```

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
