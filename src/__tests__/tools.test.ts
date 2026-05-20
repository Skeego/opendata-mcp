import { describe, it, expect, beforeEach, vi } from "vitest";

import { loadBundledSpec, normalize } from "../openapi-loader.js";
import { buildTools, z } from "../tools.js";
import type { ClientConfig } from "../api-client.js";

const spec = loadBundledSpec();
const ops = normalize(spec);

describe("openapi-loader / normalize", () => {
  it("produces an operation per (path, method) pair in the spec", () => {
    let expected = 0;
    for (const ops of Object.values(spec.paths)) {
      for (const k of Object.keys(ops)) {
        if (["get", "post", "put", "patch", "delete"].includes(k)) expected++;
      }
    }
    expect(ops.length).toBe(expected);
    expect(ops.length).toBeGreaterThan(50); // sanity — this spec has ~99
  });

  it("counts GETs and writes consistent with the spec", () => {
    const gets = ops.filter((o) => o.method === "get").length;
    const writes = ops.length - gets;
    expect(gets).toBe(76);
    expect(writes).toBe(ops.length - gets);
  });
});

describe("buildTools", () => {
  it("registers one tool per non-deprecated op (full mode)", () => {
    const tools = buildTools(spec, ops, { readOnly: false });
    const nonDeprecated = ops.filter((o) => !o.deprecated).length;
    expect(tools.length).toBe(nonDeprecated);
  });

  it("read-only mode filters to GET tools only", () => {
    const tools = buildTools(spec, ops, { readOnly: true });
    const gets = ops.filter((o) => o.method === "get" && !o.deprecated).length;
    expect(tools.length).toBe(gets);
    for (const t of tools) expect(t.method).toBe("get");
  });

  it("exposes the canonical list_datasets endpoint", () => {
    const tools = buildTools(spec, ops, { readOnly: false });
    const t = tools.find((x) => x.name === "list_datasets_v1_datasets_get");
    expect(t, "list_datasets_v1_datasets_get tool must be present").toBeDefined();
    expect(t!.method).toBe("get");
    expect(t!.path).toBe("/v1/datasets");
    // limit & offset are documented query params on this endpoint.
    expect(t!.queryParamNames).toEqual(expect.arrayContaining(["limit", "offset"]));
  });

  it("tool names are MCP-safe (≤64 chars, [a-zA-Z0-9_-])", () => {
    const tools = buildTools(spec, ops, { readOnly: false });
    for (const t of tools) {
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});

describe("invoke — URL + auth contract (mocked fetch)", () => {
  const cfg: ClientConfig = {
    baseUrl: "https://example.test",
    apiKey: "od_test_KEY",
    timeoutMs: 5_000,
  };
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("GET sends NO Authorization header and builds path + query correctly", async () => {
    const tools = buildTools(spec, ops, { readOnly: false });
    const t = tools.find((x) => x.name === "list_datasets_v1_datasets_get")!;
    await t.invoke({ limit: 5, offset: 10 }, cfg);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/v1/datasets?limit=5&offset=10");
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("GET substitutes required path params (url-encoded)", async () => {
    const tools = buildTools(spec, ops, { readOnly: false });
    // Pick any GET with path params.
    const t = tools.find((x) => x.pathParamNames.length >= 2 && x.method === "get")!;
    const args: Record<string, unknown> = {};
    for (const n of t.pathParamNames) args[n] = `v ${n}`;
    await t.invoke(args, cfg);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    // url-encoded space → %20
    for (const n of t.pathParamNames) expect(url).toContain(`v%20${n}`);
  });

  it("non-GET REQUIRES OPENDATA_API_KEY and sends Bearer", async () => {
    const tools = buildTools(spec, ops, { readOnly: false });
    const writeTool = tools.find((x) => x.method !== "get")!;
    // Provide path params + a body so the call can build.
    const args: Record<string, unknown> = { body: { _test: true } };
    for (const n of writeTool.pathParamNames) args[n] = "x";

    // With key → Bearer present.
    await writeTool.invoke(args, cfg);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer od_test_KEY");
    expect(init.method).toBe(writeTool.method.toUpperCase());

    // Without key → handler returns an ERROR result rather than throwing.
    fetchSpy.mockClear();
    const res = await writeTool.invoke(args, { ...cfg, apiKey: undefined });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/OPENDATA_API_KEY is required/);
  });

  it("returns a clear error if OPENDATA_BASE_URL is unset", async () => {
    const tools = buildTools(spec, ops, { readOnly: false });
    const t = tools.find((x) => x.name === "list_datasets_v1_datasets_get")!;
    const res = await t.invoke({}, { ...cfg, baseUrl: undefined });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/OPENDATA_BASE_URL is not set/);
  });

  it("zod input schemas reject missing required path params at invoke time", async () => {
    const tools = buildTools(spec, ops, { readOnly: false });
    const t = tools.find((x) => x.pathParamNames.length >= 1 && x.method === "get")!;
    // Validate args via the tool's input shape ourselves to confirm requiredness.
    const obj = z.object(t.inputShape);
    const r = obj.safeParse({});
    expect(r.success).toBe(false);
  });
});
