import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// OpenAPI 3.1 — the subset we actually consume. Wide types over strict ones
// so we accept whatever the bundled spec throws at us; the conversion layer
// (openapi-to-zod) is the choke point that normalizes the shape.
export type JsonValue =
  | string | number | boolean | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export interface OpenAPIParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonValue;
}

export interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenAPIParameter[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: JsonValue }> };
  responses?: Record<string, unknown>;
  security?: unknown[];
  deprecated?: boolean;
}

export interface OpenAPISpec {
  openapi: string;
  info: { title?: string; version?: string; description?: string };
  servers?: { url: string }[];
  paths: Record<string, Record<string, OpenAPIOperation> & { parameters?: OpenAPIParameter[] }>;
  components?: { schemas?: Record<string, JsonValue>; securitySchemes?: Record<string, JsonValue> };
}

export interface NormalizedOp {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  operationId: string;
  summary: string;
  description: string;
  parameters: OpenAPIParameter[];      // already merged with path-level params
  requestBodySchema?: JsonValue;       // application/json schema if any
  requestBodyRequired: boolean;
  deprecated: boolean;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

export function loadBundledSpec(): OpenAPISpec {
  // The spec ships alongside the package — resolve relative to this file so
  // it works from both `dist/` (built) and `src/` (tsx dev).
  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up until we find openapi.json (works for src/ and dist/ layouts).
  const candidates = [
    resolve(here, "..", "openapi.json"),
    resolve(here, "..", "..", "openapi.json"),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as OpenAPISpec;
    } catch {
      // try next
    }
  }
  throw new Error(`openapi.json not found near ${here}`);
}

/** Resolve a `$ref` shallowly against the spec's components. Returns the
 * pointed-at node, or the original input if no ref / not resolvable. */
export function deref(spec: OpenAPISpec, node: JsonValue): JsonValue {
  if (node && typeof node === "object" && !Array.isArray(node) && typeof (node as Record<string, JsonValue>).$ref === "string") {
    const ref = (node as Record<string, string>).$ref;
    // Only handle internal refs like #/components/schemas/Foo (the common case).
    const m = /^#\/components\/schemas\/([^/]+)$/.exec(ref);
    if (m) {
      const target = spec.components?.schemas?.[m[1]];
      if (target) return target;
    }
  }
  return node;
}

/** Flatten the spec into a list of operations, merging path-level parameters
 * into each operation and picking the application/json request body schema. */
export function normalize(spec: OpenAPISpec): NormalizedOp[] {
  const out: NormalizedOp[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    const pathParams = (pathItem.parameters ?? []) as OpenAPIParameter[];
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as OpenAPIOperation | undefined;
      if (!op) continue;
      const params = [...(pathParams ?? []), ...(op.parameters ?? [])];
      const bodyContent = op.requestBody?.content ?? {};
      const jsonBody = bodyContent["application/json"]?.schema as JsonValue | undefined;
      out.push({
        method,
        path,
        operationId: op.operationId || `${method}_${path.replace(/[^a-zA-Z0-9]+/g, "_")}`.slice(0, 64),
        summary: op.summary ?? "",
        description: op.description ?? "",
        parameters: params,
        requestBodySchema: jsonBody,
        requestBodyRequired: op.requestBody?.required ?? false,
        deprecated: !!op.deprecated,
      });
    }
  }
  return out;
}
