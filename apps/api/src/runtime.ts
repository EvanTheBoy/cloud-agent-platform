import {
  AgentOrchestrator,
  BullMqJobQueue,
  DemoLlmProvider,
  InMemoryJobQueue,
  InMemoryJobStore,
  OpenAiCompatibleProvider,
  PostgresJobStore,
  sanitizeDiagnosticValue,
  defaultTools
} from "../../../packages/agent-core/src/index.js";
import type { JobQueue, JobStore, LlmProvider } from "../../../packages/agent-core/src/index.js";
import type { Sandbox } from "../../../packages/agent-core/src/types.js";
import { DockerSandbox, LocalSandbox } from "../../../packages/sandbox/src/index.js";
import type { AppOptions } from "./app.js";

export interface ApiRuntime {
  store: JobStore;
  queue: JobQueue;
  sandbox: Sandbox;
}

export interface WorkerRuntime extends ApiRuntime {
  orchestrator: AgentOrchestrator;
}

export async function createApiRuntime(options: AppOptions): Promise<ApiRuntime> {
  const store = await createJobStore(options);
  let queue: JobQueue | undefined;

  try {
    queue = createJobQueue(options, store);
    const sandbox = createSandbox(options);
    return { store, queue, sandbox };
  } catch (error) {
    await queue?.close?.();
    await store.close?.();
    throw error;
  }
}

export async function createWorkerRuntime(options: AppOptions): Promise<WorkerRuntime> {
  const runtime = await createApiRuntime(options);

  try {
    const llm = createLlmProvider();
    const orchestrator = new AgentOrchestrator({
      store: runtime.store,
      sandbox: runtime.sandbox,
      llm,
      tools: defaultTools,
      maxSteps: options.maxSteps
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

function createJobStore(options: AppOptions): Promise<JobStore> | JobStore {
  if (options.storeDriver === "postgres") {
    if (!options.databaseUrl) {
      throw new Error("DATABASE_URL is required when STORE_DRIVER=postgres");
    }
    return PostgresJobStore.create({ connectionString: options.databaseUrl });
  }

  return new InMemoryJobStore();
}

function createJobQueue(options: AppOptions, store: JobStore): JobQueue {
  const onEvent = async (event: {
    type: "queue.enqueued" | "queue.active" | "queue.completed" | "queue.attempt_failed" | "queue.failed";
    jobId: string;
    payload?: Record<string, unknown>;
  }) => {
    await store.appendEvent({
      type: event.type,
      jobId: event.jobId,
      timestamp: new Date().toISOString(),
      payload: (event.payload ? sanitizeDiagnosticValue(event.payload) : {}) as Record<string, unknown>
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

function createLlmProvider(): LlmProvider {
  if (process.env.OPENAI_API_KEY) {
    return new OpenAiCompatibleProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL
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
