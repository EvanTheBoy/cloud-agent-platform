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
- Final job status and error message.
- Durable event history in Postgres when `STORE_DRIVER=postgres`.

This is enough to see that a job failed, but not always enough to know why a
provider, model, tool call, sandbox command, or event stream failed.

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
    "args": ["-lc", "find . -type f"]
  }
}
```

```json
{
  "toolName": "shell.exec",
  "exitCode": 0,
  "durationMs": 125,
  "stdoutBytes": 2048,
  "stderrBytes": 0
}
```

### Sandbox Events

```text
sandbox.prepare.started
sandbox.prepare.finished
sandbox.command.started
sandbox.command.finished
sandbox.command.failed
```

Useful fields:

- Sandbox driver: `local` or `docker`.
- Timeout.
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

## Sensitive Data Rules

Never log:

- API keys.
- Bearer tokens.
- Authorization headers.
- Cookies.
- SSH keys.
- Full environment variables.
- Full repository credentials or remote URLs containing credentials.

Allowed with limits:

- `baseUrlHost`, not full URL with query parameters.
- Model name.
- Provider name.
- HTTP status code.
- Tool name.
- Truncated tool argument previews.
- Truncated model response previews for parse failures.

Recommended limits:

```text
rawArgumentsPreview: first 2000 characters
responsePreview: first 4000 characters
stdoutPreview: first 4000 characters
stderrPreview: first 4000 characters
```

Store full command stdout/stderr as artifacts later, not as unbounded job event
payloads.

## Implementation Plan

### Phase 1: LLM Diagnostics

1. Extend `JobEventType` with:

```text
llm.request.started
llm.response.received
llm.tool_arguments_parse_failed
llm.request.failed
```

2. Give the LLM provider a diagnostics callback, for example:

```ts
type LlmDiagnostics = (event: {
  type: JobEventType;
  payload: Record<string, unknown>;
}) => Promise<void>;
```

3. Wire the orchestrator so diagnostics events include the current `jobId`.
4. On `JSON.parse` failure for tool arguments, record:
   - provider
   - model
   - base URL host
   - tool name
   - raw argument preview
   - raw argument length
   - parse error
5. Keep throwing the original failure so job status still becomes `failed`.

### Phase 2: Tool And Sandbox Diagnostics

1. Emit tool start/finish/failure events around tool execution.
2. Emit sandbox command start/finish/failure events around command execution.
3. Record output sizes and truncation status.
4. Avoid duplicating full stdout/stderr in multiple event payloads.

### Phase 3: Metrics And Tracing

Add process-level metrics:

- Job counts by status.
- Queue latency.
- Agent step duration.
- LLM latency and failure count by provider/model.
- Tool latency and failure count by tool name.
- Sandbox command duration and timeout count.
- Postgres query latency and pool usage.

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

The immediate next observability task is to add LLM diagnostics for
OpenAI-compatible tool-call parsing failures. This will turn the current
inference-based debugging process into event-based debugging.
