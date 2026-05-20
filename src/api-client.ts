/** HTTP client that turns a normalized OpenAPI operation + a flat parameter
 * object into an actual API call. Encapsulates the auth contract:
 *   GET = no auth required; non-GET = Bearer from OPENDATA_API_KEY.
 *
 * Also implements bounded retries on clearly-transient failures (502/503/504
 * and connection-level errors) — explicitly NOT on 500 or any 4xx, because
 * 500 means "I tried, it broke" and 4xx means "your request is wrong";
 * retrying either just hammers a working answer of 'no'.
 */

import { log, newRequestId } from "./logger.js";

export interface ClientConfig {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  timeoutMs: number;
  /** Total HTTP attempts (initial + retries) on transient failures. Default 3. */
  maxAttempts?: number;
}

export interface CallSpec {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;                     // OpenAPI path, e.g. /v1/datasets/{provider}
  pathParamNames: string[];
  queryParamNames: string[];
  /** Optional tool name — included in log lines for correlation. */
  toolName?: string;
}

export interface CallArgs {
  [key: string]: unknown;
  body?: unknown;
}

export interface CallResult {
  ok: boolean;
  status: number;
  data: unknown;
  /** A short, human-readable summary suitable for an MCP text response. */
  summary: string;
  /** Per-invocation correlation id (also appears in log lines). */
  requestId: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
    public requestId: string,
  ) {
    super(message);
  }
}

const TRANSIENT_STATUSES = new Set([502, 503, 504]);

function substitutePath(path: string, args: Record<string, unknown>, names: string[]): string {
  let out = path;
  for (const n of names) {
    const v = args[n];
    if (v === undefined || v === null || v === "") {
      throw new Error(`missing required path parameter: ${n}`);
    }
    out = out.replace(`{${n}}`, encodeURIComponent(String(v)));
  }
  return out;
}

function buildQuery(args: Record<string, unknown>, names: string[]): string {
  const usp = new URLSearchParams();
  for (const n of names) {
    const v = args[n];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) usp.append(n, String(item));
    else usp.append(n, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

function backoffMs(attempt: number): number {
  // 200ms, 600ms, 1.4s — capped — with ±20% jitter to avoid thundering herd.
  const base = Math.min(200 * 3 ** (attempt - 1), 5_000);
  const jitter = (Math.random() * 0.4 - 0.2) * base;
  return Math.max(0, Math.floor(base + jitter));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function callApi(
  cfg: ClientConfig,
  call: CallSpec,
  args: CallArgs,
): Promise<CallResult> {
  const requestId = newRequestId();

  if (!cfg.baseUrl) {
    throw new Error(
      "OPENDATA_BASE_URL is not set. Configure it in the environment before invoking API tools.",
    );
  }

  const url =
    cfg.baseUrl.replace(/\/+$/, "") +
    substitutePath(call.path, args, call.pathParamNames) +
    buildQuery(args, call.queryParamNames);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (call.method !== "get") {
    headers["Content-Type"] = "application/json";
    if (!cfg.apiKey) {
      throw new Error(
        `OPENDATA_API_KEY is required for non-GET (${call.method.toUpperCase()} ${call.path}). ` +
          `Set it in the environment.`,
      );
    }
    headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  }

  const init: RequestInit = { method: call.method.toUpperCase(), headers };
  if (call.method !== "get" && args.body !== undefined) {
    init.body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  }

  const maxAttempts = Math.max(1, cfg.maxAttempts ?? 3);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    log.debug("api.request", {
      rid: requestId, tool: call.toolName, attempt, method: call.method, url,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      const ms = Date.now() - started;

      const ct = res.headers.get("content-type") || "";
      const isJson = ct.includes("application/json");
      const rawText = await res.text();
      const data: unknown = isJson && rawText ? safeJson(rawText) : rawText;

      const summary = `${call.method.toUpperCase()} ${url} → ${res.status} ${res.statusText}`;

      if (res.ok) {
        log.info("api.success", {
          rid: requestId, tool: call.toolName, attempt, method: call.method, status: res.status, ms,
        });
        return { ok: true, status: res.status, data, summary, requestId };
      }

      // Non-OK. Retry only on the clearly-transient gateway/proxy class.
      const transient = TRANSIENT_STATUSES.has(res.status);
      log[transient && attempt < maxAttempts ? "info" : "error"]("api.non_ok", {
        rid: requestId, tool: call.toolName, attempt, method: call.method, status: res.status, ms,
        transient, willRetry: transient && attempt < maxAttempts,
        bodyPreview: typeof data === "string" ? data.slice(0, 240) : JSON.stringify(data).slice(0, 240),
      });
      if (transient && attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new ApiError(`${summary} — rid=${requestId} — ${typeof data === "string" ? data.slice(0, 240) : JSON.stringify(data).slice(0, 240)}`, res.status, data, requestId);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // Don't double-retry an ApiError thrown above for a 4xx/500.
      if (err instanceof ApiError) throw err;
      // Network / abort / DNS / etc — these ARE transient by class.
      const isAbort = (err as { name?: string } | undefined)?.name === "AbortError";
      const ms = Date.now() - started;
      log[attempt < maxAttempts ? "info" : "error"]("api.network_error", {
        rid: requestId, tool: call.toolName, attempt, method: call.method, ms,
        abort: isAbort, message: err instanceof Error ? err.message : String(err),
        willRetry: attempt < maxAttempts,
      });
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      // Out of retries — bubble out.
      throw err;
    }
  }
  // unreachable
  throw lastErr ?? new Error("callApi: unreachable");
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
