/**
 * Structured JSON logs on stdout/stderr (Cloud Logging reads `severity` and `message`).
 * Callers pass ids and reasons only: never emails, tokens, IPs or user agents.
 */

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const FORBIDDEN_KEYS = /(email|phone|token|secret|password|authorization|ip_address|client_ip|user_agent|signature|cookie|fbc|fbp)/i;
const MAX_DEPTH = 8;

/** Redact sensitive keys at every depth (objects and arrays); cut cycles and very deep nesting. */
function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (seen.has(value)) return '[cycle]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = FORBIDDEN_KEYS.test(k) ? '[redacted]' : scrubValue(v, depth + 1, seen);
  return out;
}

function scrub(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  return scrubValue(fields, 0, new WeakSet()) as Record<string, unknown>;
}

export function jsonLogger(write: (line: string, isError: boolean) => void = (line, isError) => (isError ? process.stderr : process.stdout).write(`${line}\n`)): Logger {
  const emit = (severity: 'INFO' | 'WARNING' | 'ERROR', message: string, fields?: Record<string, unknown>) =>
    write(JSON.stringify({ severity, message, time: new Date().toISOString(), ...scrub(fields) }), severity === 'ERROR');
  return {
    info: (m, f) => emit('INFO', m, f),
    warn: (m, f) => emit('WARNING', m, f),
    error: (m, f) => emit('ERROR', m, f),
  };
}

/** Collects entries in memory (tests). */
export class MemoryLogger implements Logger {
  readonly entries: Array<{ severity: string; message: string; fields: Record<string, unknown> }> = [];
  info(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ severity: 'INFO', message, fields: scrub(fields) });
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ severity: 'WARNING', message, fields: scrub(fields) });
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ severity: 'ERROR', message, fields: scrub(fields) });
  }
}
