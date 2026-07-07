# Cloud Agent Platform

A compact reference project for a cloud-hosted autonomous agent platform, inspired by Claude Code Cloud, Devin, and OpenAI-style agent runtimes.

Users submit a natural-language task. The platform creates an isolated workspace, runs an agent loop, calls an LLM for reasoning, routes tool calls to sandboxed executors, streams logs, and returns a final report.

## Stack

- **TypeScript / Node.js**: API server, orchestration loop, job state, tool routing, WebSocket streaming.
- **Fastify**: HTTP and WebSocket API.
- **In-memory queue/store**: local demo adapter; replace with BullMQ/Redis and Postgres in production.
- **Prometheus-style metrics and trace context**: process-local runtime metrics
  plus job-event trace fields for reconstructing API -> queue -> worker -> LLM
  -> tool -> sandbox execution.
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

Create a job in another terminal:

```bash
curl -X POST http://127.0.0.1:8080/jobs \
  -H "content-type: application/json" \
  -d '{"task":"Read this workspace, find TODO comments, and produce a report."}'
```

The API returns `202 Accepted` with a queued job. That means the job was
created and accepted for processing; it does not mean the agent has finished
yet. Copy the returned `job.id`, then query the job until `status` becomes
`succeeded` or `failed`:

```bash
curl http://127.0.0.1:8080/jobs/<jobId>
```

A successful run looks like this at the top level:

```json
{
  "job": {
    "id": "<jobId>",
    "status": "succeeded",
    "steps": [
      {
        "toolCall": {
          "name": "shell.exec"
        }
      }
    ],
    "result": "..."
  },
  "events": [
    { "type": "job.created", "payload": { "traceId": "..." } },
    { "type": "queue.enqueued", "payload": { "traceId": "...", "spanId": "..." } },
    { "type": "queue.active", "payload": { "traceId": "...", "spanId": "...", "parentSpanId": "..." } },
    { "type": "step.started", "payload": { "traceId": "..." } },
    { "type": "step.finished", "payload": { "traceId": "..." } },
    { "type": "job.finished", "payload": { "traceId": "..." } },
    { "type": "queue.completed", "payload": { "traceId": "..." } }
  ]
}
```

The important checks are:

- `job.status` is `succeeded`.
- `job.steps` contains one or more tool calls such as `shell.exec`.
- `job.result` contains the final agent output.
- `events` shows the lifecycle from creation through queue completion.
- Event payloads include trace fields when trace context is available, so the
  in-platform trace tree can be reconstructed from job history.

For local demos the API copies `DEFAULT_SOURCE_PATH` into the job sandbox, excluding `node_modules`, `dist`, `.git`, and prior `workspace-runs`. You can override it per request:

```bash
curl -X POST http://127.0.0.1:8080/jobs \
  -H "content-type: application/json" \
  -d '{"task":"Find TODO comments.","sourcePath":"/path/to/repo"}'
```

You can also watch job events over WebSocket:

```bash
node -e 'const ws = new WebSocket("ws://127.0.0.1:8080/jobs/<jobId>/events"); ws.onmessage = (event) => console.log(event.data);'
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
To use Redis-backed BullMQ dispatch with a separate worker process, run Redis,
Postgres, the API, and the worker. For a disposable local test, Redis and
Postgres can both run in Docker.

Start Redis and Postgres:

```bash
docker run --name cap-redis \
  -p 6379:6379 \
  -d redis:7

docker run --name cap-postgres \
  -e POSTGRES_USER=cap \
  -e POSTGRES_PASSWORD=cap \
  -e POSTGRES_DB=cloud_agent_platform \
  -p 5432:5432 \
  -d postgres:16

docker exec cap-redis redis-cli ping
```

`docker exec cap-redis redis-cli ping` should print `PONG`.

In one terminal, start the API:

```bash
OPENAI_API_KEY= \
STORE_DRIVER=postgres \
DATABASE_URL=postgres://cap:cap@127.0.0.1:5432/cloud_agent_platform \
QUEUE_DRIVER=bullmq \
REDIS_URL=redis://127.0.0.1:6379 \
SANDBOX_ROOT="$(pwd)/workspace-runs" \
JOB_CONCURRENCY=2 \
JOB_MAX_ATTEMPTS=3 \
npm run dev:api
```

In a second terminal, start the worker:

```bash
OPENAI_API_KEY= \
STORE_DRIVER=postgres \
DATABASE_URL=postgres://cap:cap@127.0.0.1:5432/cloud_agent_platform \
QUEUE_DRIVER=bullmq \
REDIS_URL=redis://127.0.0.1:6379 \
SANDBOX_ROOT="$(pwd)/workspace-runs" \
JOB_CONCURRENCY=2 \
JOB_MAX_ATTEMPTS=3 \
WORKER_METRICS_HOST=127.0.0.1 \
WORKER_METRICS_PORT=9091 \
npm run dev:worker
```

In a third terminal, submit and query a job:

```bash
curl -X POST http://127.0.0.1:8080/jobs \
  -H "content-type: application/json" \
  -d '{"task":"Read this repository, find all TODO comments, and generate a concise report grouped by file."}'

curl http://127.0.0.1:8080/jobs/<jobId>
```

The successful BullMQ path is confirmed when the queried job has
`"status":"succeeded"` and queue events include BullMQ payloads such as:

```json
{ "type": "queue.enqueued", "payload": { "driver": "bullmq" } }
{ "type": "queue.active", "payload": { "driver": "bullmq" } }
{ "type": "queue.completed", "payload": { "driver": "bullmq", "finalStatus": "succeeded" } }
```

`OPENAI_API_KEY=` intentionally clears any `.env` API key for this deterministic
test, causing the worker to use the built-in demo LLM provider. To test a real
OpenAI-compatible endpoint instead, remove that override and configure
`OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL`.

The API exposes API-process metrics at `http://127.0.0.1:8080/metrics`. The
standalone worker exposes worker-process metrics at
`http://127.0.0.1:9091/metrics` by default. Set `WORKER_METRICS_HOST=0.0.0.0`
when the worker runs in a container and Prometheus needs to scrape it over the
container network. Prometheus should scrape both API and worker targets in
BullMQ mode because LLM, tool, sandbox, and orchestrator metrics are recorded in
the worker process.

Job events also carry trace context in BullMQ mode. The API creates a root trace
context, the queue span is stored in BullMQ job data, and the worker continues
the same trace for LLM, tool, and sandbox diagnostics. This is an in-platform
trace reconstruction path today; future OpenTelemetry integration can export the
same span boundaries to an external collector.

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

Remove the disposable Redis and Postgres containers after testing:

```bash
docker rm -f cap-redis cap-postgres
```

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
