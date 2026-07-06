# Production Upgrade Plan

This project started with small local adapters so the agent platform could run
as a compact demo. Several production-oriented adapters now exist, but some
operational pieces are still intentionally incomplete. The main remaining
upgrade areas are event streaming, observability, cancellation, artifact
storage, and production controls.

## Current State

```text
Memory demo mode

Fastify API
  -> InMemoryJobStore / PostgresJobStore
  -> InMemoryJobQueue
  -> AgentOrchestrator
  -> LocalSandbox / DockerSandbox
  -> LLM Provider

BullMQ/Postgres split mode

Fastify API
  -> PostgresJobStore
  -> BullMqJobQueue enqueue

Worker Process
  -> BullMqJobQueue process
  -> AgentOrchestrator
  -> LocalSandbox / DockerSandbox
  -> LLM Provider
```

The current design is useful because the boundaries are already interface-based:

- `JobQueue` abstracts scheduling. Current implementations: memory and BullMQ.
- `JobStore` abstracts job state and events. Current implementations: memory and
  Postgres.
- `Sandbox` abstracts isolated execution. Current implementations: local
  workspace and Docker.
- `LlmProvider` abstracts model calls.
- `Tool` abstracts agent capabilities.

That means the production work should add stronger implementations behind these
interfaces, not rewrite the whole orchestrator.

## 1. Queue Upgrade

### Current Implementation

The project now has two queue drivers:

- `InMemoryJobQueue` for local demos and tests.
- `BullMqJobQueue` for Redis-backed dispatch.

The memory queue supports:

- FIFO scheduling.
- Simple concurrency control.
- Local development with no external services.

The BullMQ queue supports:

- Redis-backed job dispatch.
- Configurable concurrency.
- Retry attempts with exponential backoff.
- Configurable retention for completed and failed BullMQ job records.
- Queue lifecycle events persisted through `JobStore`.
- Failed enqueue attempts mark the already-created job as failed so durable
  state does not leave orphan queued jobs.

### Limitations

- BullMQ processing now runs from a separate worker entrypoint.
- API and worker startup are split for BullMQ/Postgres mode.
- API and worker must share the same sandbox workspace path; workers validate
  the stored workspace path before running the agent.
- Queue event persistence is best-effort after the durable queue operation.
  Missing lifecycle events, such as `queue.active`, must be diagnosed from
  worker logs or future metrics rather than treated as proof that the job did
  not run.
- No dead-letter queue.
- No priority support.
- No delayed jobs.
- Queue observability is event-based but not yet metrics/tracing-based.

### Target Implementation

Use a durable queue:

- Recommended for this project: **BullMQ + Redis**.
- Alternative for workflow-heavy systems: **Temporal**.
- Cloud-native alternatives: **AWS SQS**, **Google Cloud Tasks**, **RabbitMQ**.

Recommended architecture:

```text
API Server
  -> create job in Postgres
  -> enqueue jobId into BullMQ

Worker Process
  -> consume jobId from BullMQ
  -> run AgentOrchestrator.run(jobId)
  -> update job state/events in Postgres
```

### Implementation Tasks

1. ~~Add `BullMqJobQueue implements JobQueue`.~~ Done.
2. ~~Move worker startup into a separate worker entrypoint, for example
   `apps/worker/src/worker.ts`.~~ Done.
3. ~~Keep `InMemoryJobQueue` for local demos and tests.~~ Done.
4. ~~Add queue configuration.~~ Done:

```text
QUEUE_DRIVER=memory|bullmq
REDIS_URL=redis://localhost:6379
JOB_CONCURRENCY=2
JOB_MAX_ATTEMPTS=3
QUEUE_REMOVE_ON_COMPLETE_AGE=3600
QUEUE_REMOVE_ON_COMPLETE_COUNT=1000
QUEUE_REMOVE_ON_FAIL_AGE=86400
QUEUE_REMOVE_ON_FAIL_COUNT=5000
```

5. ~~Add retry/backoff policy.~~ Done for processor failures.
6. Add a dead-letter queue for permanently failed jobs.
7. ~~Record queue state transitions as job events.~~ Done.

## 2. Job Store Upgrade

### Current Implementation

The project now has two job store drivers:

- `InMemoryJobStore` for local demos and tests.
- `PostgresJobStore` for durable jobs and event history.

The store interface supports:

- Creating jobs.
- Updating job status.
- Listing jobs.
- Appending events.
- Returning job events for polling and WebSocket streaming.

### Limitations

- In memory mode, job history is still lost on process restart.
- Postgres mode provides durable state for the split API and worker processes.
- No tenant isolation.
- Postgres has basic query indexes and a durable event log.
- No artifact metadata.
- No cancellation state that survives restarts.

### Target Implementation

Use **Postgres** as the durable source of truth.

Recommended tables:

```text
jobs
  id
  task
  status
  workspace_path
  result
  error
  created_at
  updated_at

job_steps
  id
  job_id
  step_index
  thought
  tool_name
  tool_input_json
  observation
  started_at
  finished_at

job_events
  id
  job_id
  type
  payload_json
  created_at

artifacts
  id
  job_id
  path
  content_type
  size_bytes
  storage_url
  created_at
```

### Implementation Tasks

1. ~~Add `PostgresJobStore implements JobStore`.~~ Done.
2. ~~Add database migrations.~~ Done with
   `migrations/001_postgres_job_store.sql`.
3. ~~Keep `InMemoryJobStore` for demo mode.~~ Done.
4. ~~Add store configuration.~~ Done:

```text
STORE_DRIVER=memory|postgres
DATABASE_URL=postgres://...
```

5. ~~Persist every job event before notifying WebSocket clients.~~ Done for the
   current polling-based WebSocket endpoint.
6. ~~Add indexes on `jobs.status`, `jobs.created_at`, and job event lookup.~~
   Done.
7. Add cancellation support with a durable status such as `cancel_requested`.

### Current Gaps

- Steps are stored as `jobs.steps_json` rather than normalized `job_steps`.
  This is acceptable for the current aggregate read/write pattern, but
  normalized steps are still useful for analytics and detailed audit queries.
- Artifact metadata is not implemented.
- Auto-running `CREATE TABLE IF NOT EXISTS` is acceptable for the demo, but
  production should use explicit migration execution and schema compatibility
  checks.
- A gated Postgres integration test exists and runs when `DATABASE_URL` is set.

## 3. Sandbox Upgrade

### Current Implementation

The project now has two sandbox drivers:

- `LocalSandbox`, which creates one workspace directory per job and executes
  commands on the host inside that directory.
- `DockerSandbox`, which executes commands inside short-lived Docker
  containers with the job workspace mounted at `/workspace`.

The sandbox layer supports:

- Per-job workspace directories.
- Importing source code into the workspace.
- Running shell commands with timeout.
- Capturing stdout, stderr, exit code, and duration.

### Limitations

- Local mode still runs commands on the host machine.
- Docker mode improves isolation, but production policy and audit controls still
  need to mature.
- Network policy modes are still coarse.
- Stale workspace/container cleanup is not automated.
- Command audit data is not yet emitted as structured job events.

### Target Implementation

Add `DockerSandbox implements Sandbox`.

Each job should run commands inside a short-lived container or a managed job
container.

Recommended command model:

```text
docker run --rm
  --network none
  --memory 512m
  --cpus 1
  --workdir /workspace
  -v <job-workspace>:/workspace
  cloud-agent-sandbox:latest
  <command>
```

For stronger isolation later, consider:

- Kubernetes Jobs or Pods.
- gVisor.
- Kata Containers.
- Firecracker microVMs.

### Implementation Tasks

1. ~~Add `DockerSandbox implements Sandbox`.~~ Done.
2. ~~Create a sandbox image, for example `Dockerfile.sandbox`.~~ Done.
3. ~~Add resource limit configuration.~~ Done:

```text
SANDBOX_DRIVER=local|docker
SANDBOX_IMAGE=cloud-agent-sandbox:latest
SANDBOX_CPUS=1
SANDBOX_MEMORY=512m
SANDBOX_NETWORK=none
SANDBOX_TIMEOUT_MS=120000
```

4. ~~Mount only the job workspace into the container.~~ Done.
5. ~~Avoid mounting host credentials, Docker socket, or project root directly.~~
   Done.
6. Add network policy modes:

```text
none
allow_package_registry
allow_all
```

7. Add cleanup for stale workspaces and containers.
8. Capture command audit data as job events.

## 4. Event Streaming Upgrade

### Current Implementation

The WebSocket endpoint polls `store.getEvents(jobId)` every 500ms and sends new
events based on `lastCount`.

This is fine for a local demo.

### Limitations

- Polling every 500ms does not scale well.
- In-memory events cannot be shared across multiple API servers.
- WebSocket delivery is tied to the API process.

### Target Implementation

Use persisted events plus pub/sub:

```text
Worker
  -> writes event to Postgres
  -> publishes event to Redis Pub/Sub

API WebSocket Server
  -> subscribes to Redis channel
  -> sends event to connected clients
```

This keeps the durable audit log in Postgres while Redis handles low-latency
delivery.

## 5. Observability Upgrade

### Current Implementation

The platform persists basic job, step, and queue events. Postgres mode makes
those events durable. A separate observability plan now records the next
diagnostics work in `docs/OBSERVABILITY_PLAN.md`.

### Current Gaps

- LLM provider failures do not include enough context to debug malformed tool
  calls from persisted events alone.
- Tool execution and sandbox command diagnostics are not yet structured as
  first-class job events.
- There are no metrics for latency, failure rate, queue depth, or Postgres pool
  health.
- There is no tracing across API, queue, worker, LLM, and sandbox boundaries.

### Implementation Tasks

1. Add LLM diagnostics events:

```text
llm.request.started
llm.response.received
llm.tool_arguments_parse_failed
llm.request.failed
```

2. Ensure diagnostics never persist API keys, bearer tokens, cookies, or full
   secret-bearing URLs.
3. Add tool and sandbox diagnostics events.
4. Add bounded previews for malformed model output and command output.
5. Add metrics for job status, queue latency, LLM latency, tool latency,
   sandbox failures, and Postgres pool/query health.
6. Add tracing when API and worker processes are split.

## 6. Suggested Upgrade Phases

### Phase 1: Make The Demo Credible

- ~~Keep the current in-memory queue and store.~~ Done.
- ~~Add `DockerSandbox`.~~ Done.
- Improve docs and demo scripts. Partially done.
- Show that commands run inside a container instead of directly on the host.
  Partially done.

This phase targets the assignment requirement around sandbox and isolation.

### Phase 2: Separate API And Worker

- ~~Add a worker entrypoint.~~ Done.
- ~~Add `BullMqJobQueue`.~~ Done.
- ~~Use Redis for durable job dispatch.~~ Done with separate API and worker
  processes.
- ~~Keep `InMemoryJobStore` if needed, but prefer moving to Postgres soon
  after.~~ Done.

This phase targets scheduling, concurrency, retries, and scalability.

### Phase 3: Durable State

- ~~Add `PostgresJobStore`.~~ Done.
- Persist jobs, steps, events, and artifacts. Jobs, steps JSON, and events are
  done; artifacts remain.
- ~~Add migrations and indexes.~~ Done.
- ~~Make job status survive restarts.~~ Done in Postgres mode and verified with
  a real Postgres container.

This phase targets production reliability and auditability.

### Phase 4: Production Controls

- Add tenant/user ownership.
- Add auth.
- Add quotas and rate limits.
- Add cancellation.
- Add command/network policy enforcement.
- Add artifact scanning.
- Add metrics and tracing.

### Phase 5: Observability And Operations

- Add LLM diagnostics events.
- Add tool and sandbox diagnostics events.
- Add metrics and tracing.
- Add explicit migration commands.
- Add operational runbooks for Redis, Postgres, worker, and sandbox failures.

## 7. Final Target Architecture

```text
Client / Web UI
  -> API Server
      -> PostgresJobStore
      -> BullMQ enqueue
      -> WebSocket event stream

Worker Pool
  -> BullMQ consume
  -> AgentOrchestrator
      -> LLM Provider
      -> Tool Router
      -> DockerSandbox / KubernetesSandbox
  -> Postgres job steps/events
  -> Object Storage artifacts

Redis
  -> durable queue backend
  -> optional event pub/sub

Postgres
  -> jobs
  -> job_steps
  -> job_events
  -> artifact metadata

Object Storage
  -> workspace snapshots
  -> generated reports
  -> logs and artifacts
```

## Recommendation

The original highest-value upgrades were:

1. Add `DockerSandbox`.
2. Add `BullMqJobQueue`.
3. Add `PostgresJobStore`.

Those are now implemented at a first production-oriented level. The highest
value next changes are:

1. Add LLM diagnostics and broader observability.
2. Add durable cancellation.
3. Add artifact metadata and object storage.
4. Add tenant/auth/quota controls.
