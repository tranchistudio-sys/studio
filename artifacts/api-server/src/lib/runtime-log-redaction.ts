const CONSOLE_REDACTION_MARKER = Symbol.for("amazing-studio.console-redaction-installed");
const CONSOLE_METHODS = ["debug", "info", "log", "warn", "error"] as const;

const SENSITIVE_KEY = /(?:authorization|cookie|set-cookie|password|credential|access[_-]?token|refresh[_-]?token|token(?:[_-]?hash)?|csrf|secret|connection[_-]?string|database[_-]?(?:url|password))/i;

export function redactRuntimeLogString(input: string): string {
  return input
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/)[^@\s/]+@/gi,
      "$1[REDACTED]@",
    )
    .replace(
      /(["'](?:authorization|cookie|set-cookie|password|credential|access[_-]?token|refresh[_-]?token|token(?:[_-]?hash)?|csrf|secret|connection[_-]?string|database[_-]?(?:url|password))["']\s*:\s*["'])[^"']*(["'])/gi,
      "$1[REDACTED]$2",
    )
    .replace(
      /\b(authorization|cookie|set-cookie|password|credential|access[_-]?token|refresh[_-]?token|token(?:[_-]?hash)?|csrf|secret|connection[_-]?string|database[_-]?(?:url|password))\b\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /([?&](?:access_token|refresh_token|token|credential|csrf|secret|sig|signature)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[REDACTED_TOKEN]");
}

export function sanitizeRuntimeLogValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") return redactRuntimeLogString(value);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint" || typeof value === "symbol") return String(value);
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 6) return "[Truncated]";
  if (typeof value !== "object") return redactRuntimeLogString(String(value));
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (value instanceof Error) {
    const error = value as Error & { code?: unknown; cause?: unknown };
    return {
      name: error.name,
      message: redactRuntimeLogString(error.message),
      ...(error.code !== undefined ? { code: sanitizeRuntimeLogValue(error.code, depth + 1, seen) } : {}),
      ...(error.cause !== undefined ? { cause: sanitizeRuntimeLogValue(error.cause, depth + 1, seen) } : {}),
      ...(error.stack ? { stack: redactRuntimeLogString(error.stack) } : {}),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => sanitizeRuntimeLogValue(entry, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    output[key] = SENSITIVE_KEY.test(key)
      ? "[REDACTED]"
      : sanitizeRuntimeLogValue(entry, depth + 1, seen);
  }
  return output;
}

export function installRuntimeConsoleRedaction(target: Console = console): void {
  const markedTarget = target as Console & { [CONSOLE_REDACTION_MARKER]?: boolean };
  if (markedTarget[CONSOLE_REDACTION_MARKER]) return;

  for (const method of CONSOLE_METHODS) {
    const original = target[method].bind(target);
    target[method] = ((...args: unknown[]) => {
      original(...args.map((value) => sanitizeRuntimeLogValue(value)));
    }) as Console[typeof method];
  }
  Object.defineProperty(markedTarget, CONSOLE_REDACTION_MARKER, {
    configurable: false,
    enumerable: false,
    value: true,
  });
}
