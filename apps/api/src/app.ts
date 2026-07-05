import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  AgentOrchestrator,
  BullMqJobQueue,
  DemoLlmProvider,
  InMemoryJobQueue,
  InMemoryJobStore,
  OpenAiCompatibleProvider,
  PostgresJobStore,
  defaultTools
} from "../../../packages/agent-core/src/index.js";
import type { JobQueue, JobStore, LlmProvider } from "../../../packages/agent-core/src/index.js";
import type { Sandbox } from "../../../packages/agent-core/src/types.js";
import { DockerSandbox, LocalSandbox } from "../../../packages/sandbox/src/index.js";

const createJobSchema = z.object({
  task: z.string().min(3),
  sourcePath: z.string().optional()
});

export interface AppOptions {
  sandboxRoot: string;
  sandboxDriver?: "local" | "docker";
  sandboxImage?: string;
  sandboxCpus?: string;
  sandboxMemory?: string;
  sandboxNetwork?: "none" | "bridge" | "host";
  sandboxUser?: string;
  sandboxPidsLimit?: number;
  sandboxTimeoutMs?: number;
  queueDriver?: "memory" | "bullmq";
  redisUrl?: string;
  storeDriver?: "memory" | "postgres";
  databaseUrl?: string;
  jobConcurrency?: number;
  jobMaxAttempts?: number;
  maxSteps: number;
  defaultSourcePath?: string;
  allowedSourceRoot?: string;
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const store = await createJobStore(options);
  let queue: JobQueue | undefined;
  let sandbox: Sandbox | undefined;

  try {
    queue = createJobQueue(options, store);
    sandbox = createSandbox(options);
    const llm = createLlmProvider();
    const orchestrator = new AgentOrchestrator({
      store,
      sandbox,
      llm,
      tools: defaultTools,
      maxSteps: options.maxSteps
    });

    queue.process(async (jobId) => {
      return orchestrator.run(jobId);
    });
  } catch (error) {
    await queue?.close?.();
    await store.close?.();
    throw error;
  }

  if (!queue || !sandbox) {
    await store.close?.();
    throw new Error("Failed to initialize application resources");
  }

  app.addHook("onClose", async () => {
    await queue.close?.();
    await store.close?.();
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/jobs", async () => {
    return { jobs: await store.list() };
  });

  app.post("/jobs", async (request, reply) => {
    const parsed = createJobSchema.parse(request.body);
    const jobId = crypto.randomUUID();
    const sourcePath = await resolveAllowedSourcePath(
      parsed.sourcePath ?? options.defaultSourcePath ?? process.cwd(),
      options.allowedSourceRoot ?? options.defaultSourcePath ?? process.cwd()
    );
    const workspacePath = await sandbox.prepare(jobId);
    await sandbox.importDirectory(jobId, sourcePath);
    const job = await store.create({ id: jobId, task: parsed.task, workspacePath });
    await queue.enqueue(job.id);
    return reply.code(202).send({ job });
  });

  app.get("/jobs/:jobId", async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = await store.get(jobId);
    if (!job) {
      return reply.code(404).send({ error: "Job not found" });
    }
    return { job, events: await store.getEvents(jobId) };
  });

  app.get("/jobs/:jobId/events", { websocket: true }, (connection, request) => {
    const { jobId } = request.params as { jobId: string };
    let lastCount = 0;

    const sendEvents = async () => {
      const events = await store.getEvents(jobId);
      for (const event of events.slice(lastCount)) {
        connection.socket.send(JSON.stringify(event));
      }
      lastCount = events.length;
    };

    const interval = setInterval(() => {
      void sendEvents();
    }, 500);

    connection.socket.on("close", () => {
      clearInterval(interval);
    });

    void sendEvents();
  });

  return app;
}

async function createJobStore(options: AppOptions): Promise<JobStore> {
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
      payload: event.payload ?? {}
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

async function resolveAllowedSourcePath(sourcePath: string, allowedRoot: string): Promise<string> {
  const realSourcePath = await realpath(resolve(sourcePath));
  const realAllowedRoot = await realpath(resolve(allowedRoot));
  const rel = relative(realAllowedRoot, realSourcePath);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`sourcePath must be inside allowed source root: ${realAllowedRoot}`);
  }
  return realSourcePath;
}
