# Production Upgrade Plan

This project currently uses small local adapters so the agent platform can run as
a compact demo. To move it toward a production-grade Cloud Agent Platform, the
main upgrade areas are the job queue, job state storage, and sandbox runtime.

## Current State

```text
Fastify API
  -> InMemoryJobStore
  -> InMemoryJobQueue
  -> AgentOrchestrator
  -> LocalSandbox
  -> LLM Provider
```

The current design is useful because the boundaries are already interface-based:

- `JobQueue` abstracts scheduling.
- `JobStore` abstracts job state and events.
- `Sandbox` abstracts isolated execution.
- `LlmProvider` abstracts model calls.
- `Tool` abstracts agent capabilities.

That means the production work should add stronger implementations behind these
interfaces, not rewrite the whole orchestrator.

## 1. Queue Upgrade

### Current Implementation

`InMemoryJobQueue` stores pending job IDs in a local array and uses an
`EventEmitter` to dispatch work to the orchestrator.

It supports:

- FIFO scheduling.
- Simple concurrency control.
- Local development with no external services.

### Limitations

- Jobs are lost when the process restarts.
- Multiple API or worker processes cannot share the queue.
- No retry policy.
- No exponential backoff.
- No dead-letter queue.
- No priority support.
- No delayed jobs.
- No production observability.
- No clean separation between API and worker processes.

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

1. Add `BullMqJobQueue implements JobQueue`.
2. Move worker startup into a separate worker entrypoint, for example
   `apps/worker/src/worker.ts`.
3. Keep `InMemoryJobQueue` for local demos and tests.
4. Add queue configuration:

```text
QUEUE_DRIVER=memory|bullmq
REDIS_URL=redis://localhost:6379
JOB_CONCURRENCY=2
JOB_MAX_ATTEMPTS=3
```

5. Add retry/backoff policy.
6. Add a dead-letter queue for permanently failed jobs.
7. Record queue state transitions as job events.

## 2. Job Store Upgrade

### Current Implementation

The demo uses an in-memory store for jobs and events.

It supports:

- Creating jobs.
- Updating job status.
- Listing jobs.
- Appending events.
- Returning job events for polling and WebSocket streaming.

### Limitations

- Job history is lost on process restart.
- No multi-process consistency.
- No tenant isolation.
- No query indexes.
- No durable audit log.
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

1. Add `PostgresJobStore implements JobStore`.
2. Add database migrations.
3. Keep `InMemoryJobStore` for demo mode.
4. Add store configuration:

```text
STORE_DRIVER=memory|postgres
DATABASE_URL=postgres://...
```

5. Persist every job event before notifying WebSocket clients.
6. Add indexes on `jobs.status`, `jobs.created_at`, and `job_events.job_id`.
7. Add cancellation support with a durable status such as `cancel_requested`.

## 3. Sandbox Upgrade

### Current Implementation

`LocalSandbox` creates one workspace directory per job and executes commands
inside that directory.

It supports:

- Per-job workspace directories.
- Importing source code into the workspace.
- Running shell commands with timeout.
- Capturing stdout, stderr, exit code, and duration.

### Limitations

- Commands still run on the host machine.
- Filesystem isolation is only directory-based.
- CPU and memory limits are weak or absent.
- Network access is not strongly controlled.
- A malicious command could affect the host environment.
- Execution environment is not fully reproducible.
- No container image boundary.

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

1. Add `DockerSandbox implements Sandbox`.
2. Create a sandbox image, for example `Dockerfile.sandbox`.
3. Add resource limits:

```text
SANDBOX_DRIVER=local|docker
SANDBOX_IMAGE=cloud-agent-sandbox:latest
SANDBOX_CPU=1
SANDBOX_MEMORY=512m
SANDBOX_NETWORK=none
SANDBOX_TIMEOUT_MS=120000
```

4. Mount only the job workspace into the container.
5. Avoid mounting host credentials, Docker socket, or project root directly.
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

## 5. Suggested Upgrade Phases

### Phase 1: Make The Demo Credible

- Keep the current in-memory queue and store.
- Add `DockerSandbox`.
- Improve docs and demo scripts.
- Show that commands run inside a container instead of directly on the host.

This phase targets the assignment requirement around sandbox and isolation.

### Phase 2: Separate API And Worker

- Add a worker entrypoint.
- Add `BullMqJobQueue`.
- Use Redis for durable job dispatch.
- Keep `InMemoryJobStore` if needed, but prefer moving to Postgres soon after.

This phase targets scheduling, concurrency, retries, and scalability.

### Phase 3: Durable State

- Add `PostgresJobStore`.
- Persist jobs, steps, events, and artifacts.
- Add migrations and indexes.
- Make job status survive restarts.

This phase targets production reliability and auditability.

### Phase 4: Production Controls

- Add tenant/user ownership.
- Add auth.
- Add quotas and rate limits.
- Add cancellation.
- Add command/network policy enforcement.
- Add artifact scanning.
- Add metrics and tracing.

## 6. Final Target Architecture

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

For this project, the highest-value next changes are:

1. Add `DockerSandbox`.
2. Add `BullMqJobQueue`.
3. Add `PostgresJobStore`.

If only one production upgrade can be implemented, choose `DockerSandbox`,
because sandbox isolation is one of the clearest requirements of the assignment
and the current local-directory sandbox is the easiest part for reviewers to
question.
