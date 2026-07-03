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

The API server loads `.env` from the project root on startup. When `OPENAI_API_KEY`
is set, it uses the OpenAI-compatible chat-completions provider configured by
`OPENAI_BASE_URL` and `OPENAI_MODEL`; otherwise it falls back to the local demo
provider.

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

## Docker Sandbox Mode

The default sandbox driver is `local`, which executes commands directly on the
host inside a per-job workspace. To run each command in an isolated Docker
container instead, build the sandbox image and start the API with the Docker
driver:

```bash
docker build -f Dockerfile.sandbox -t cloud-agent-sandbox:latest .

SANDBOX_DRIVER=docker \
SANDBOX_IMAGE=cloud-agent-sandbox:latest \
SANDBOX_NETWORK=none \
SANDBOX_MEMORY=512m \
SANDBOX_CPUS=1 \
npm run dev
```

In Docker mode, every `shell.exec` call starts a short-lived container with the
job workspace mounted at `/workspace`. Containers are removed after each
command, while the per-job workspace remains on the host so later steps in the
same job can see earlier file changes.

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
