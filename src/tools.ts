import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import type { NormalizedOp, OpenAPISpec } from "./openapi-loader.js";
import { jsonSchemaToZod } from "./openapi-to-zod.js";
import { type ClientConfig, callApi, ApiError } from "./api-client.js";
import { log, newRequestId } from "./logger.js";

export interface ToolDef {
  name: string;
  description: string;
  inputShape: ZodRawShape;
  pathParamNames: string[];
  queryParamNames: string[];
  method: NormalizedOp["method"];
  path: string;
  invoke(args: Record<string, unknown>, cfg: ClientConfig): Promise<{ content: { type: "text"; text: string }[] }>;
}

const MCP_NAME_RE = /[^a-zA-Z0-9_-]/g;

function safeName(id: string): string {
  return id.replace(MCP_NAME_RE, "_").slice(0, 64);
}

function shortDescription(op: NormalizedOp): string {
  const head = `${op.method.toUpperCase()} ${op.path}`;
  const auth = op.method === "get" ? "(public)" : "(auth: Bearer OPENDATA_API_KEY)";
  const body = [op.summary, op.description].filter(Boolean).join(" — ");
  const tail = body ? ` — ${body}` : "";
  const full = `${head} ${auth}${tail}`;
  return full.length > 800 ? full.slice(0, 797) + "…" : full;
}

function buildInputShape(spec: OpenAPISpec, op: NormalizedOp): ZodRawShape {
  const shape: ZodRawShape = {};
  for (const p of op.parameters) {
    if (p.in !== "path" && p.in !== "query") continue;
    let schema: ZodTypeAny = jsonSchemaToZod(spec, p.schema ?? {});
    if (p.description) schema = schema.describe(p.description);
    if (!p.required && p.in !== "path") schema = schema.optional();
    shape[p.name] = schema;
  }
  if (op.method !== "get" && op.requestBodySchema) {
    let body = jsonSchemaToZod(spec, op.requestBodySchema).describe(
      `Request body (application/json) for ${op.method.toUpperCase()} ${op.path}`,
    );
    if (!op.requestBodyRequired) body = body.optional();
    const key = "body" in shape ? "request_body" : "body";
    shape[key] = body;
  }
  return shape;
}

export function buildTools(spec: OpenAPISpec, ops: NormalizedOp[], opts: { readOnly: boolean }): ToolDef[] {
  const out: ToolDef[] = [];
  const usedNames = new Set<string>();

  for (const op of ops) {
    if (opts.readOnly && op.method !== "get") continue;
    if (op.deprecated) continue;

    let name = safeName(op.operationId);
    let n = 2;
    while (usedNames.has(name)) name = safeName(`${op.operationId}_${n++}`);
    usedNames.add(name);

    const inputShape = buildInputShape(spec, op);
    const pathParamNames = op.parameters.filter((p) => p.in === "path").map((p) => p.name);
    const queryParamNames = op.parameters.filter((p) => p.in === "query").map((p) => p.name);

    out.push({
      name,
      description: shortDescription(op),
      inputShape,
      pathParamNames,
      queryParamNames,
      method: op.method,
      path: op.path,
      async invoke(args, cfg) {
        const t0 = Date.now();
        log.debug("tool.invoke", { tool: name, method: op.method, path: op.path });
        try {
          const res = await callApi(
            cfg,
            { method: op.method, path: op.path, pathParamNames, queryParamNames, toolName: name },
            args,
          );
          const dataText =
            typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);
          const max = 200_000;
          const body = dataText.length > max
            ? dataText.slice(0, max) + `\n\n…[truncated ${dataText.length - max} chars]`
            : dataText;
          log.debug("tool.invoke.done", { tool: name, status: res.status, ms: Date.now() - t0, rid: res.requestId });
          return { content: [{ type: "text" as const, text: `${res.summary}\n\n${body}` }] };
        } catch (err: unknown) {
          // Pre-flight errors (missing path param, missing key, missing base
          // URL) won't have a requestId from the client; mint one so the
          // operator can still grep this line.
          const rid = err instanceof ApiError ? err.requestId : newRequestId();
          const msg = err instanceof Error ? err.message : String(err);
          log.error("tool.invoke.error", {
            tool: name, method: op.method, path: op.path, ms: Date.now() - t0,
            rid, kind: err instanceof ApiError ? "api_error" : "pre_flight",
            status: err instanceof ApiError ? err.status : undefined,
            message: msg,
          });
          return { content: [{ type: "text" as const, text: `ERROR (rid=${rid}): ${msg}` }] };
        }
      },
    });
  }
  return out;
}

export { z };
