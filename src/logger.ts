/**
 * Tiny structured logger. Writes one JSON object per line to stderr (stdout
 * is reserved for the MCP protocol). No deps, no file I/O — the MCP host's
 * process captures stderr.
 *
 * Levels: off < error < info < debug. Set via OPENDATA_LOG_LEVEL.
 */

export type LogLevel = "off" | "error" | "info" | "debug";

const ORDER: Record<LogLevel, number> = { off: -1, error: 0, info: 1, debug: 2 };

let current: LogLevel = "info";

export function configureLogger(level?: string): void {
  const k = (level ?? "info").toLowerCase();
  if (k === "off" || k === "error" || k === "info" || k === "debug") current = k;
}

export function logLevel(): LogLevel {
  return current;
}

function emit(level: Exclude<LogLevel, "off">, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[current] < ORDER[level]) return;
  // Stable ordering: ts/level/msg first, then fields. JSON.stringify handles
  // undefined and circular-safe primitives we use here.
  const row = { ts: new Date().toISOString(), level, msg, ...(fields ?? {}) };
  try {
    process.stderr.write(JSON.stringify(row) + "\n");
  } catch {
    // Logging must never throw into the caller. Best-effort fallback.
    try { process.stderr.write(`{"ts":"${new Date().toISOString()}","level":"${level}","msg":${JSON.stringify(msg)}}\n`); } catch { /* give up */ }
  }
}

export const log = {
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
  info:  (msg: string, fields?: Record<string, unknown>) => emit("info",  msg, fields),
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
};

/** Short opaque id for correlating a tool invocation across its log lines
 * and (optionally) the error text returned to the caller. */
export function newRequestId(): string {
  // 64 bits of entropy is plenty for in-process correlation; hex for grep-ability.
  const a = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  const b = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return a + b;
}
