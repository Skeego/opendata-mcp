/** HTTP client that turns a normalized OpenAPI operation + a flat parameter
 * object into an actual API call. Encapsulates the auth contract:
 * GET = no auth required; non-GET = Bearer from OPENDATA_API_KEY. */

export interface ClientConfig {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  timeoutMs: number;
}

export interface CallSpec {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;                     // OpenAPI path, e.g. /v1/datasets/{provider}
  pathParamNames: string[];
  queryParamNames: string[];
  /** Names of params that should be treated as headers (rare; we don't see any in this spec). */
  headerParamNames?: string[];
}

export interface CallArgs {
  [key: string]: unknown;
  /** Optional request body for non-GET ops. */
  body?: unknown;
}

export interface CallResult {
  ok: boolean;
  status: number;
  /** Parsed JSON when content-type was JSON; else raw text. */
  data: unknown;
  /** A short, human-readable summary suitable for an MCP text response. */
  summary: string;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public body: unknown) {
    super(message);
  }
}

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

export async function callApi(
  cfg: ClientConfig,
  call: CallSpec,
  args: CallArgs,
): Promise<CallResult> {
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  init.signal = controller.signal;

  let res: Response;
  try {
    res = await fetch(url, init);
  } finally {
    clearTimeout(timer);
  }

  const ct = res.headers.get("content-type") || "";
  const isJson = ct.includes("application/json");
  const rawText = await res.text();
  const data: unknown = isJson && rawText ? safeJson(rawText) : rawText;

  const summary = `${call.method.toUpperCase()} ${url} → ${res.status} ${res.statusText}`;
  if (!res.ok) {
    throw new ApiError(`${summary} — ${typeof data === "string" ? data.slice(0, 240) : JSON.stringify(data).slice(0, 240)}`, res.status, data);
  }

  return { ok: true, status: res.status, data, summary };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
