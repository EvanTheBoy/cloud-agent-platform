import { randomBytes } from "node:crypto";
import type { TraceContext } from "./types.js";

export function createRootTraceContext(): TraceContext {
  return {
    traceId: randomHex(16),
    spanId: randomHex(8)
  };
}

export function createChildTraceContext(parent?: TraceContext): TraceContext {
  if (!parent) {
    return createRootTraceContext();
  }

  return {
    traceId: parent.traceId,
    spanId: randomHex(8),
    parentSpanId: parent.spanId
  };
}

export function tracePayloadFields(traceContext?: TraceContext): Record<string, unknown> {
  return traceContext
    ? {
        traceId: traceContext.traceId,
        spanId: traceContext.spanId,
        ...(traceContext.parentSpanId ? { parentSpanId: traceContext.parentSpanId } : {})
      }
    : {};
}

export function isTraceContext(value: unknown): value is TraceContext {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeTrace = value as Record<string, unknown>;
  return (
    typeof maybeTrace.traceId === "string" &&
    typeof maybeTrace.spanId === "string" &&
    (maybeTrace.parentSpanId === undefined || typeof maybeTrace.parentSpanId === "string")
  );
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
