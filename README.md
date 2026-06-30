# Cloud Agent Platform

A compact reference project for a cloud-hosted autonomous agent platform, inspired by Claude Code Cloud, Devin, and OpenAI-style agent runtimes.

Users submit a natural-language task. The platform creates an isolated workspace, runs an agent loop, calls an LLM for reasoning, routes tool calls to sandboxed executors, streams logs, and returns a final report.

## Stack

- **TypeScript / Node.js**: API server, orchestration loop, job state, tool routing, WebSocket streaming.
- **Fastify**: HTTP and WebSocket API.
- **In-memory queue/store**: local demo adapter; replace with BullMQ/Redis and Postgres in production.
- **Sandbox package**: local process sandbox for demo, with a Docker executor interface documented for production.
- **Python/Bash/Node ready**: tool execution is language-agnostic inside sandbox workspaces.

## Quick Start

```bash
npm install
npm run dev
```

Create a job:

```bash
curl -X POST http://127.0.0.1:8080/jobs \
  -H "content-type: application/json" \
  -d '{"task":"Read this workspace, find TODO comments, and produce a report."}'
```

For local demos the API copies `DEFAULT_SOURCE_PATH` into the job sandbox, excluding `node_modules`, `dist`, `.git`, and prior `workspace-runs`. You can override it per request:

```bash
curl -X POST http://127.0.0.1:8080/jobs \
  -H "content-type: application/json" \
  -d '{"task":"Find TODO comments.","sourcePath":"/path/to/repo"}'
```

Open job events:

```bash
curl http://127.0.0.1:8080/jobs/<jobId>
```

## Project Layout

```text
apps/api              Fastify API, job endpoints, websocket streaming
apps/web              Minimal dashboard prototype
packages/agent-core   Agent loop, tools, LLM provider interface, job state
packages/sandbox      Isolated command execution primitives
docs                  Architecture and submission notes
examples              Example tasks and expected outputs
```

## Production Upgrade Path

- Replace `InMemoryJobStore` with Postgres.
- Replace `InMemoryJobQueue` with BullMQ/Redis or Temporal.
- Replace `LocalSandbox` with Docker, Kubernetes Jobs, or Firecracker.
- Store workspace snapshots and artifacts in object storage.
- Add auth, tenant quotas, audit logs, rate limits, and policy enforcement.
