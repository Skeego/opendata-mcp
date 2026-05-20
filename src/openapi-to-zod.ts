import { z, type ZodTypeAny } from "zod";
import type { JsonValue, OpenAPISpec } from "./openapi-loader.js";
import { deref } from "./openapi-loader.js";

/** Convert an OpenAPI schema node to a Zod schema. Best-effort: we cover the
 * cases the OpenData spec actually uses (primitives, enums, arrays, objects,
 * nullable via anyOf, $ref to components/schemas) and fall back to z.any()
 * for anything exotic so the tool still works, just less strictly typed. */
export function jsonSchemaToZod(spec: OpenAPISpec, node: JsonValue, seen = new Set<string>()): ZodTypeAny {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return z.any();
  const obj = node as Record<string, JsonValue>;

  // $ref — shallow resolve with cycle guard.
  if (typeof obj.$ref === "string") {
    if (seen.has(obj.$ref)) return z.any();
    seen.add(obj.$ref);
    const target = deref(spec, obj);
    return jsonSchemaToZod(spec, target, seen);
  }

  // Nullable via anyOf: [<schema>, {type:'null'}] — common in OpenAPI 3.1.
  if (Array.isArray(obj.anyOf)) {
    const nonNull = (obj.anyOf as JsonValue[]).filter(
      (s) => !(typeof s === "object" && s !== null && !Array.isArray(s) && (s as { type?: string }).type === "null")
    );
    const hasNull = (obj.anyOf as JsonValue[]).some(
      (s) => typeof s === "object" && s !== null && !Array.isArray(s) && (s as { type?: string }).type === "null"
    );
    if (nonNull.length === 1) {
      const base = jsonSchemaToZod(spec, nonNull[0], seen);
      return hasNull ? base.nullable() : base;
    }
    if (nonNull.length > 1) {
      const opts = nonNull.map((s) => jsonSchemaToZod(spec, s, seen)) as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]];
      const u = z.union(opts);
      return hasNull ? u.nullable() : u;
    }
  }
  if (Array.isArray(obj.oneOf)) {
    const opts = (obj.oneOf as JsonValue[]).map((s) => jsonSchemaToZod(spec, s, seen));
    if (opts.length >= 2) return z.union(opts as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
    if (opts.length === 1) return opts[0];
  }

  // Enum (string / int).
  if (Array.isArray(obj.enum)) {
    const values = obj.enum as JsonValue[];
    if (values.every((v) => typeof v === "string")) {
      return z.enum(values as [string, ...string[]]);
    }
    // Mixed/numeric enums — fall back to a permissive literal union.
    return z.any();
  }

  const t = obj.type as string | string[] | undefined;
  if (Array.isArray(t)) {
    // Multiple types — keep it permissive.
    return z.any();
  }

  switch (t) {
    case "string": {
      let s: ZodTypeAny = z.string();
      if (typeof obj.minLength === "number") s = (s as z.ZodString).min(obj.minLength as number);
      if (typeof obj.maxLength === "number") s = (s as z.ZodString).max(obj.maxLength as number);
      return s;
    }
    case "integer":
    case "number": {
      let n: z.ZodNumber = z.number();
      if (t === "integer") n = n.int();
      if (typeof obj.minimum === "number") n = n.min(obj.minimum as number);
      if (typeof obj.maximum === "number") n = n.max(obj.maximum as number);
      return n;
    }
    case "boolean":
      return z.boolean();
    case "array": {
      const items = (obj.items as JsonValue) ?? {};
      return z.array(jsonSchemaToZod(spec, items, seen));
    }
    case "object": {
      const props = (obj.properties as Record<string, JsonValue>) ?? {};
      const required = new Set((obj.required as string[] | undefined) ?? []);
      const shape: Record<string, ZodTypeAny> = {};
      for (const [k, v] of Object.entries(props)) {
        const child = jsonSchemaToZod(spec, v, seen);
        shape[k] = required.has(k) ? child : child.optional();
      }
      return z.object(shape).passthrough();
    }
    default:
      return z.any();
  }
}
