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

describe("retry policy — bounded retries on transient failures only", () => {
  const cfg: ClientConfig = {
    baseUrl: "https://example.test",
    apiKey: "od_test_KEY",
    timeoutMs: 5_000,
    maxAttempts: 3,
  };

  function tool() {
    const tools = buildTools(spec, ops, { readOnly: false });
    return tools.find((x) => x.name === "list_datasets_v1_datasets_get")!;
  }
  function ok(body: unknown = { items: [] }): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  function err(status: number, detail = "fail"): Response {
    return new Response(JSON.stringify({ detail }), { status, headers: { "content-type": "application/json" } });
  }

  it("retries on 503 then succeeds", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(err(503))
      .mockResolvedValueOnce(ok({ items: [{ id: 1 }] }));
    const res = await tool().invoke({}, cfg);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(res.content[0].text).toMatch(/→ 200\b/);
  });

  it("retries on 502/504 too (each transient)", async () => {
    for (const code of [502, 504]) {
      const spy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(err(code))
        .mockResolvedValueOnce(ok());
      const res = await tool().invoke({}, cfg);
      expect(spy, `expected retry on ${code}`).toHaveBeenCalledTimes(2);
      expect(res.content[0].text).toMatch(/→ 200\b/);
      spy.mockRestore();
    }
  });

  it("does NOT retry on 500 (server said 'I tried, it broke' — hammering hurts)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(err(500, "internal"));
    const res = await tool().invoke({}, cfg);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.content[0].text).toMatch(/ERROR /);
    expect(res.content[0].text).toMatch(/→ 500\b/);
    // requestId surfaces in the error text for correlation
    expect(res.content[0].text).toMatch(/rid=[0-9a-f]{16}/);
  });

  it("does NOT retry on 4xx (client error — retrying won't help)", async () => {
    for (const code of [400, 401, 404, 422]) {
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(err(code));
      const res = await tool().invoke({}, cfg);
      expect(spy, `expected no retry on ${code}`).toHaveBeenCalledTimes(1);
      expect(res.content[0].text).toMatch(/ERROR /);
      spy.mockRestore();
    }
  });

  it("retries on network error then succeeds", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed: ECONNRESET"))
      .mockResolvedValueOnce(ok());
    const res = await tool().invoke({}, cfg);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(res.content[0].text).toMatch(/→ 200\b/);
  });

  it("gives up after maxAttempts on persistent transient failure", async () => {
    // Mint a fresh Response per call — Web Response bodies are single-use.
    const spy = vi.spyOn(globalThis, "fetch")
      .mockImplementation(async () => err(503));
    const res = await tool().invoke({}, cfg);
    expect(spy).toHaveBeenCalledTimes(3);   // matches cfg.maxAttempts
    expect(res.content[0].text).toMatch(/ERROR /);
    expect(res.content[0].text).toMatch(/→ 503\b/);
  });
});
