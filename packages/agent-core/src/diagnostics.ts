import type { AgentJob } from "./types.js";

const SENSITIVE_KEY_PATTERN = /api[_-]?key|authorization|bearer|cookie|password|secret|token/i;
const SECRET_QUERY_PARAM_PATTERN =
  /([?&][^=&#]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)[^=&#]*=)[^&#\s"']+/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[:=]\s*[^\s,;&"']+/gi;
const SECRET_JSON_FIELD_PATTERN =
  /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)["']?\s*:\s*["'])[^"']*(["'])/gi;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;

export const DIAGNOSTIC_TEXT_PREVIEW_LIMIT = 4000;

export function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 3) {
    return "[max depth]";
  }

  if (typeof value === "string") {
    return truncate(redactSensitiveText(value), 500);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeDiagnosticValue(item, depth + 1));
  }

  if (typeof value === "object" && value) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 20)) {
      output[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeDiagnosticValue(item, depth + 1);
    }
    return output;
  }

  return String(value);
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(URL_PATTERN, "[url redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(Authorization\s*:\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/\b(Cookie\s*:\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(SECRET_JSON_FIELD_PATTERN, "$1[redacted]$2")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1=[redacted]")
    .replace(SECRET_QUERY_PARAM_PATTERN, "$1[redacted]");
}

export function previewDiagnosticText(value: string, limit: number): string {
  return truncate(redactSensitiveText(value), limit);
}

export function diagnosticTextFields(field: string, value: string, limit = DIAGNOSTIC_TEXT_PREVIEW_LIMIT): Record<string, unknown> {
  return {
    [`${field}Preview`]: previewDiagnosticText(value, limit),
    [`${field}Bytes`]: Buffer.byteLength(value, "utf8")
  };
}

export function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...[truncated]` : value;
}

export function jobEventPayload(job: AgentJob): Record<string, unknown> {
  const { task, result, error, ...jobWithoutSensitiveText } = job;
  return {
    ...jobWithoutSensitiveText,
    ...diagnosticTextFields("task", task),
    ...(result ? diagnosticTextFields("result", result) : {}),
    ...(error ? diagnosticTextFields("error", error) : {})
  };
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}
