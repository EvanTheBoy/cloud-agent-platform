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

Docker sandbox execution also applies conservative defaults such as dropped
capabilities, `no-new-privileges`, a PID limit, a read-only container root
filesystem, a writable `/tmp` tmpfs, and the host numeric UID/GID where
available. Set `SANDBOX_USER` only when you intentionally need a fixed container
user. Source imports are restricted to `SANDBOX_SOURCE_ROOT` and startup fails
on invalid sandbox configuration values.

## BullMQ Queue Mode

The default queue driver is `memory`, which is useful for local demos and tests.
To use Redis-backed BullMQ dispatch with a separate worker process, start Redis
and run both the API and worker with the BullMQ driver:

```bash
brew services start redis

STORE_DRIVER=postgres \
DATABASE_URL=postgres://user:password@127.0.0.1:5432/cloud_agent_platform \
QUEUE_DRIVER=bullmq \
REDIS_URL=redis://127.0.0.1:6379 \
JOB_CONCURRENCY=2 \
JOB_MAX_ATTEMPTS=3 \
npm run dev:api
```

In a second terminal, start the worker:

```bash
STORE_DRIVER=postgres \
DATABASE_URL=postgres://user:password@127.0.0.1:5432/cloud_agent_platform \
QUEUE_DRIVER=bullmq \
REDIS_URL=redis://127.0.0.1:6379 \
JOB_CONCURRENCY=2 \
JOB_MAX_ATTEMPTS=3 \
npm run dev:worker
```

BullMQ mode persists queued job dispatch in Redis and applies exponential
backoff for processor errors. In BullMQ mode, the API creates jobs and enqueues
job IDs, while `apps/worker/src/worker.ts` consumes the queue and runs the agent
orchestrator. The worker requires `STORE_DRIVER=postgres` and
`QUEUE_DRIVER=bullmq` so job state and events survive process restarts.

The API and worker must also use the same shared sandbox workspace. In local
development this usually means running both processes on the same host with the
same absolute `SANDBOX_ROOT`. In containerized deployments, mount the same
volume at the same path in both containers. The worker validates the stored
workspace path before running the agent so a misconfigured worker fails the job
instead of silently processing an empty workspace.

For local development it is useful to keep completed and failed BullMQ job
records in Redis for debugging. In long-running production environments, Redis
should not be treated as the permanent audit log. Prefer keeping durable job
history in Postgres and configuring BullMQ retention by age/count, for example:

```text
QUEUE_REMOVE_ON_COMPLETE_AGE=3600
QUEUE_REMOVE_ON_COMPLETE_COUNT=1000
QUEUE_REMOVE_ON_FAIL_AGE=86400
QUEUE_REMOVE_ON_FAIL_COUNT=5000
```

This keeps successful queue records for a shorter window and failed records
longer for investigation, while preventing Redis from growing without bound.

## PostgreSQL Job Store Mode

The default job store is `memory`, which is useful for local demos and tests.
To persist jobs and event history across API process restarts, run the API with
the Postgres store driver:

```bash
STORE_DRIVER=postgres \
DATABASE_URL=postgres://user:password@127.0.0.1:5432/cloud_agent_platform \
npm run dev
```

On startup, the Postgres store creates the required `jobs` and `job_events`
tables if they do not already exist. The same schema is available in
`migrations/001_postgres_job_store.sql` for environments that apply migrations
outside the application process.

Postgres mode persists job state, completed steps, results, errors, and the
event stream used by the `/jobs/:jobId` and WebSocket endpoints. The in-memory
store remains the default so the project can still run without external
services.

When running the separate worker, use the same `STORE_DRIVER=postgres` and
`DATABASE_URL` values for both the API and worker. The API enqueues jobs, and
the worker is responsible for moving jobs through `running`, `succeeded`, and
`failed` states.

## Project Layout

```text
apps/api              Fastify API, job endpoints, websocket streaming
apps/web              Minimal dashboard prototype
packages/agent-core   Agent loop, tools, LLM provider interface, job state
packages/sandbox      Isolated command execution primitives
docs                  Architecture and submission notes
examples              Example tasks and expected outputs
migrations            SQL schema migrations for production backends
```

## Production Upgrade Path

- Replace `InMemoryJobStore` with Postgres.
- Use `BullMqJobQueue` with Redis for durable dispatch through the separate worker process.
- Replace `LocalSandbox` with Docker, Kubernetes Jobs, or Firecracker.
- Store workspace snapshots and artifacts in object storage.
- Add auth, tenant quotas, audit logs, rate limits, and policy enforcement.
