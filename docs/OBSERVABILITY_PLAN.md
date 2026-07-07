# Observability Plan

This document records the current observability gap found while verifying the
Postgres job store and outlines the next production upgrade area: structured
diagnostics for agent, LLM, tool, queue, and storage behavior.

## Why This Matters

During Postgres verification, a job was persisted correctly but failed during
agent execution with this error:

```text
Expected ':' after property name in JSON at position 23
```

The job and events were durable in Postgres, so the storage integration worked.
However, the persisted error did not include enough LLM-provider context to
prove exactly what happened without reading code.

The likely failure path was:

```text
OpenAiCompatibleProvider
  -> received tool_calls from an OpenAI-compatible endpoint
  -> parsed function.arguments with JSON.parse(...)
  -> failed because arguments was not valid JSON
```

That conclusion came from the error shape and code path, not from complete
runtime diagnostics. Production observability should make that kind of failure
self-explanatory from job events and logs.

## Current State

The platform currently records:

- Job creation and updates.
- Queue lifecycle events.
- Step started and finished events.
- OpenAI-compatible LLM request, response, request failure, and malformed
  tool-argument diagnostics.
- Tool execution start, finish, and failure diagnostics.
- Sandbox command start, finish, and failure diagnostics with output byte counts
  and truncation flags.
- Step started/finished events store tool input and observation previews instead
  of full unbounded payloads.
- Job result remains the user-visible business artifact, while job event
  payloads store only redacted, bounded result previews.
- Final job status and error message.
- Durable event history in Postgres when `STORE_DRIVER=postgres`.
- In-process Prometheus metrics at `/metrics` for API/worker-local runtime
  behavior, including job outcomes, queue events, queue latency when observable
  in the current process, agent steps, LLM requests, tools, sandbox commands,
  and job store operations.

This is enough to see that a job failed and to diagnose malformed
OpenAI-compatible tool-call arguments, thrown tool errors, and sandbox command
execution behavior. Distributed tracing across API, queue, worker, LLM, and
sandbox boundaries is still incomplete.

## Observability Goals

1. Make failed runs diagnosable from persisted job events.
2. Avoid logging secrets such as API keys, bearer tokens, cookies, or private
   repository credentials.
3. Preserve enough request/response metadata to distinguish provider errors,
   model format errors, tool execution errors, queue failures, and persistence
   failures.
4. Keep event payloads bounded so a single bad model response or command output
   cannot create huge database rows.
5. Make event ordering stable for streaming clients by using database insertion
   order for cursors.

## Proposed Job Events

### LLM Events

```text
llm.request.started
llm.response.received
llm.tool_arguments_parse_failed
llm.request.failed
```

Suggested payloads:

```json
{
  "provider": "openai-compatible",
  "model": "qwen-plus",
  "baseUrlHost": "example.com",
  "messageCount": 3,
  "toolCount": 2
}
```

```json
{
  "provider": "openai-compatible",
  "model": "qwen-plus",
  "status": 200,
  "choiceCount": 1,
  "toolCallCount": 1,
  "durationMs": 1234
}
```

```json
{
  "provider": "openai-compatible",
  "model": "qwen-plus",
  "baseUrlHost": "example.com",
  "toolName": "shell.exec",
  "reason": "invalid_json",
  "rawArgumentsPreview": "{\"command\" \"sh\"}",
  "rawArgumentsLength": 16,
  "parseError": "Expected ':' after property name in JSON at position 10"
}
```

### Tool Events

```text
tool.started
tool.finished
tool.failed
```

Suggested payloads:

```json
{
  "toolName": "shell.exec",
  "inputPreview": {
    "command": "sh",
    "argsCount": 2,
    "requestedTimeoutMs": 30000
  }
}
```

```json
{
  "toolName": "shell.exec",
  "durationMs": 125,
  "observationBytes": 2200,
  "final": false
}
```

### Sandbox Events

```text
sandbox.command.started
sandbox.command.finished
sandbox.command.failed
```

Useful fields:

- Sandbox driver: `local` or `docker`.
- Requested timeout when the tool supplied one.
- Exit code.
- Duration.
- Output byte counts.
- Whether output was truncated.

### Persistence Events

Most job store operations should not create extra events because event writes
are themselves the audit log. Operational logs or metrics should still track:

- Database connection failures.
- Migration failures.
- Query duration.
- Pool exhaustion.

Queue lifecycle events such as `queue.enqueued` should be treated as
best-effort observability after the durable queue operation succeeds. If
BullMQ accepts a job but recording the corresponding job event fails, the
enqueue operation should still be considered successful because the worker can
already consume the job from Redis. The event persistence failure should be
tracked separately instead of changing job status.

The same best-effort rule applies to `queue.active` and diagnostic events such
as `llm.*`, `tool.*`, and `sandbox.command.*`. If recording one of those events
fails, the worker should still run the job. In that case the persisted event
stream may have gaps; whether a missing event was an event persistence failure
is only visible through fallback logs or metrics.

Production follow-up options:

- Event outbox: after `queue.add` succeeds, persist the intended job event to an
  outbox and let a background worker retry writing it to `JobStore`.
- Metrics and alerting: increment counters such as
  `queue_event_persist_failed_total{event="queue.active"}` when event recording
  fails.
- Structured fallback logs: when `appendEvent` fails, write a structured log
  that can be collected by the logging pipeline, including fields such as
  `event`, `jobId`, `attempt`, and `error`.
- Store-level retry: let `appendEvent` retry short database failures before
  surfacing the error.

## Sensitive Data Rules

Never log:

- API keys.
- Bearer tokens.
- Authorization headers.
- Cookies.
- Full URLs.
- SSH keys.
- Full environment variables.
- Full repository credentials or remote URLs containing credentials.

Allowed with limits:

- `baseUrlHost`, not full URL with query parameters.
- Model name.
- Provider name.
- HTTP status code.
- Tool name.
- Redacted and truncated tool argument previews.
- Truncated model response previews for parse failures.
- Redacted tool input previews for diagnostic events.
- Redacted and truncated step observation previews.
- Redacted and truncated final result previews.

Recommended limits:

```text
rawArgumentsPreview: first 500 characters after redaction
responsePreview: first 4000 characters
stdoutPreview: first 4000 characters
stderrPreview: first 4000 characters
step observation preview: first 4000 characters after redaction
job result preview: first 4000 characters after redaction
```

Store full command stdout/stderr as artifacts later, not as unbounded job event
payloads.

## Implementation Plan

### Phase 1: LLM Diagnostics

Status: implemented for OpenAI-compatible request lifecycle events and
malformed tool-call argument parsing.

1. ~~Extend `JobEventType` with:~~

```text
llm.request.started
llm.response.received
llm.tool_arguments_parse_failed
llm.request.failed
```

2. ~~Give the LLM provider a diagnostics callback, for example:~~

```ts
type LlmDiagnostics = (event: {
  type: JobEventType;
  payload: Record<string, unknown>;
}) => Promise<void>;
```

3. ~~Wire the orchestrator so diagnostics events include the current `jobId`.~~
4. ~~On `JSON.parse` failure for tool arguments, record:~~
   - provider
   - model
   - base URL host
   - tool name
   - raw argument preview
   - raw argument length
   - parse error
5. ~~Keep throwing the original failure so job status still becomes `failed`.~~

### Phase 2: Tool And Sandbox Diagnostics

Status: implemented for orchestrator-managed tool execution and sandbox
commands made through `sandbox.exec`.

1. ~~Emit tool start/finish/failure events around tool execution.~~
2. ~~Emit sandbox command start/finish/failure events around command execution.~~
3. ~~Record output sizes and truncation status.~~
4. ~~Avoid duplicating full stdout/stderr in multiple event payloads.~~
5. ~~Keep diagnostic event writes best-effort so observability failures do not
   change job behavior.~~
6. ~~Keep persisted step events and job step state bounded and redacted.~~
7. ~~Keep final job result event payloads bounded and redacted without
   modifying the user-visible `jobs.result` value.~~

### Phase 3: Metrics And Tracing

Status: process-level metrics are implemented with a dependency-free in-memory
recorder and Prometheus text rendering. Distributed tracing is still pending.

Implemented process-level metrics:

- Job counts by status.
- Queue lifecycle event counts.
- Queue latency when enqueue and activation are observed in the same process.
- Agent step duration.
- LLM latency and failure count by provider/model.
- LLM malformed tool-argument parse failure count by provider/model/tool/reason.
- Tool latency and failure count by tool name.
- Sandbox command duration, failure count, and timeout count.
- Job store operation latency and failure count by store driver/operation.

OpenTelemetry would be a reasonable fit once the platform has separate API and
worker processes.

## Acceptance Criteria

A failed LLM tool-call parse should leave enough persisted data to answer:

- Which provider and model were used?
- Which tool call failed?
- What was the raw argument preview?
- What parse error occurred?
- Was the provider request successful at the HTTP level?
- How long did the provider request take?

No persisted event should expose API keys or authorization secrets.

## Current Follow-Up

The immediate next observability task is distributed tracing across API, queue,
worker, LLM, and sandbox boundaries. The current metrics are process-local, so
BullMQ API/worker deployments need each process scraped separately until an
OpenTelemetry exporter or central metrics backend is introduced.
