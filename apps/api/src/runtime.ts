import {
  AgentOrchestrator,
  BullMqJobQueue,
  DemoLlmProvider,
  InMemoryJobQueue,
  InMemoryJobStore,
  InMemoryMetricsRecorder,
  InstrumentedJobStore,
  OpenAiCompatibleProvider,
  PostgresJobStore,
  recordIncrement,
  recordObservation,
  sanitizeDiagnosticValue,
  tracePayloadFields,
  defaultTools
} from "../../../packages/agent-core/src/index.js";
import type { JobQueue, JobStore, LlmProvider, MetricsRecorder, QueueEvent } from "../../../packages/agent-core/src/index.js";
import type { Sandbox } from "../../../packages/agent-core/src/types.js";
import { DockerSandbox, LocalSandbox } from "../../../packages/sandbox/src/index.js";
import type { AppOptions } from "./app.js";

export interface ApiRuntime {
  store: JobStore;
  queue: JobQueue;
  sandbox: Sandbox;
  metrics: MetricsRecorder;
}

export interface WorkerRuntime extends ApiRuntime {
  orchestrator: AgentOrchestrator;
}

export async function createApiRuntime(options: AppOptions): Promise<ApiRuntime> {
  const metrics = options.metrics ?? new InMemoryMetricsRecorder();
  const { store, driver: storeDriver } = await createJobStore(options);
  const instrumentedStore = new InstrumentedJobStore(store, metrics, storeDriver);
  let queue: JobQueue | undefined;

  try {
    queue = createJobQueue(options, instrumentedStore, metrics);
    const sandbox = createSandbox(options);
    return { store: instrumentedStore, queue, sandbox, metrics };
  } catch (error) {
    await queue?.close?.();
    await instrumentedStore.close?.();
    throw error;
  }
}

export async function createWorkerRuntime(options: AppOptions): Promise<WorkerRuntime> {
  const runtime = await createApiRuntime(options);

  try {
    const llm = createLlmProvider(runtime.metrics);
    const orchestrator = new AgentOrchestrator({
      store: runtime.store,
      sandbox: runtime.sandbox,
      llm,
      tools: defaultTools,
      maxSteps: options.maxSteps,
      metrics: runtime.metrics
    });

    return { ...runtime, orchestrator };
  } catch (error) {
    await closeAgentRuntime(runtime);
    throw error;
  }
}

export async function closeAgentRuntime(runtime: Pick<ApiRuntime, "queue" | "store">): Promise<void> {
  await runtime.queue.close?.();
  await runtime.store.close?.();
}

async function createJobStore(options: AppOptions): Promise<{ store: JobStore; driver: string }> {
  if (options.storeDriver === "postgres") {
    if (!options.databaseUrl) {
      throw new Error("DATABASE_URL is required when STORE_DRIVER=postgres");
    }
    return { store: await PostgresJobStore.create({ connectionString: options.databaseUrl }), driver: "postgres" };
  }

  return { store: new InMemoryJobStore(), driver: "memory" };
}

function createJobQueue(options: AppOptions, store: JobStore, metrics: MetricsRecorder): JobQueue {
  const queueDriver = options.queueDriver === "bullmq" ? "bullmq" : "memory";
  const enqueuedAtByJobId = new Map<string, number>();
  const onEvent = async (event: QueueEvent) => {
    recordQueueMetrics(metrics, queueDriver, enqueuedAtByJobId, event);
    await store.appendEvent({
      type: event.type,
      jobId: event.jobId,
      timestamp: new Date().toISOString(),
      payload: {
        ...((event.payload ? sanitizeDiagnosticValue(event.payload) : {}) as Record<string, unknown>),
        ...tracePayloadFields(event.traceContext)
      }
    });
  };

  if (options.queueDriver === "bullmq") {
    if (!options.redisUrl) {
      throw new Error("REDIS_URL is required when QUEUE_DRIVER=bullmq");
    }
    return new BullMqJobQueue({
      redisUrl: options.redisUrl,
      concurrency: options.jobConcurrency,
      maxAttempts: options.jobMaxAttempts,
      removeOnComplete: buildBullMqRetention(options.queueRemoveOnCompleteAge, options.queueRemoveOnCompleteCount),
      removeOnFail: buildBullMqRetention(options.queueRemoveOnFailAge, options.queueRemoveOnFailCount),
      onEvent
    });
  }

  return new InMemoryJobQueue(options.jobConcurrency ?? 2, onEvent);
}

function createSandbox(options: AppOptions): Sandbox {
  if (options.sandboxDriver === "docker") {
    return new DockerSandbox({
      rootDir: options.sandboxRoot,
      image: options.sandboxImage ?? "cloud-agent-sandbox:latest",
      cpus: options.sandboxCpus,
      memory: options.sandboxMemory,
      network: options.sandboxNetwork ?? "none",
      user: options.sandboxUser,
      pidsLimit: options.sandboxPidsLimit,
      defaultTimeoutMs: options.sandboxTimeoutMs
    });
  }

  return new LocalSandbox({ rootDir: options.sandboxRoot });
}

function createLlmProvider(metrics: MetricsRecorder): LlmProvider {
  if (process.env.OPENAI_API_KEY) {
    return new OpenAiCompatibleProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL,
      metrics
    });
  }

  return new DemoLlmProvider();
}

function buildBullMqRetention(age?: number, count?: number) {
  if (age !== undefined) {
    return count !== undefined ? { age, count } : { age };
  }
  if (count !== undefined) {
    return { count };
  }
  return false;
}

function recordQueueMetrics(
  metrics: MetricsRecorder,
  queueDriver: string,
  enqueuedAtByJobId: Map<string, number>,
  event: {
    type: "queue.enqueued" | "queue.active" | "queue.completed" | "queue.attempt_failed" | "queue.failed";
    jobId: string;
    payload?: Record<string, unknown>;
  }
): void {
  const queueEvent = event.type.replace(/^queue\./, "");
  recordIncrement(metrics, "agent_queue_events_total", {
    driver: queueDriver,
    event: queueEvent,
    status:
      typeof event.payload?.finalStatus === "string"
        ? event.payload.finalStatus
        : typeof event.payload?.status === "string"
          ? event.payload.status
          : undefined,
    failureKind: typeof event.payload?.failureKind === "string" ? event.payload.failureKind : undefined
  });

  if (event.type === "queue.enqueued") {
    enqueuedAtByJobId.set(event.jobId, Date.now());
    return;
  }

  if (event.type === "queue.active") {
    const enqueuedAt = enqueuedAtByJobId.get(event.jobId);
    if (enqueuedAt !== undefined) {
      recordObservation(metrics, "agent_queue_latency_ms", Date.now() - enqueuedAt, { driver: queueDriver });
    }
  }

  if (event.type === "queue.completed" || event.type === "queue.failed") {
    enqueuedAtByJobId.delete(event.jobId);
  }
}
