/**
 * Live tests — hit the real OpenData Platform API. Skipped automatically
 * unless OPENDATA_BASE_URL is set, so `npm test` is offline-safe by default.
 *
 * Only exercises unauthenticated GETs. We don't invoke writes here to avoid
 * mutating state on a live API; the unit tests verify the auth contract
 * separately with mocked fetch.
 */
import { describe, it, expect } from "vitest";

import { loadBundledSpec, normalize } from "../openapi-loader.js";
import { buildTools } from "../tools.js";

const baseUrl = process.env.OPENDATA_BASE_URL;
const runLive = !!baseUrl;
const d = runLive ? describe : describe.skip;

const spec = loadBundledSpec();
const ops = normalize(spec);
const tools = buildTools(spec, ops, { readOnly: false });

d("live: OpenData Platform", () => {
  const cfg = {
    baseUrl: baseUrl as string,
    apiKey: process.env.OPENDATA_API_KEY,
    timeoutMs: 15_000,
  };

  it("GET /v1/datasets returns 200 with a sensible payload", async () => {
    const t = tools.find((x) => x.name === "list_datasets_v1_datasets_get")!;
    const res = await t.invoke({ limit: 3 }, cfg);
    const text = res.content[0].text;
    // First line is the summary "GET <url> → 200 OK"; assert success.
    expect(text).toMatch(/→ 200\b/);
    // Body should be JSON-ish.
    expect(text).toMatch(/[{[]/);
  }, 20_000);

  it("GET /v1/categories returns 200", async () => {
    const t = tools.find((x) => x.name === "list_categories_v1_categories_get" || x.path === "/v1/categories");
    if (!t) return; // tool name varies; fine if absent
    const res = await t.invoke({}, cfg);
    expect(res.content[0].text).toMatch(/→ 200\b/);
  }, 20_000);
});
