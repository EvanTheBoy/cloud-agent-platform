import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { z } from "zod";
import {
  AgentOrchestrator,
  DemoLlmProvider,
  InMemoryJobQueue,
  InMemoryJobStore,
  OpenAiCompatibleProvider,
  defaultTools
} from "../../../packages/agent-core/src/index.js";
import { DockerSandbox, LocalSandbox } from "../../../packages/sandbox/src/index.js";
import type { LlmProvider } from "../../../packages/agent-core/src/index.js";
import type { Sandbox } from "../../../packages/agent-core/src/types.js";

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
  sandboxTimeoutMs?: number;
  maxSteps: number;
  defaultSourcePath?: string;
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const store = new InMemoryJobStore();
  const queue = new InMemoryJobQueue(2);
  const sandbox = createSandbox(options);
  const llm = createLlmProvider();
  const orchestrator = new AgentOrchestrator({
    store,
    sandbox,
    llm,
    tools: defaultTools,
    maxSteps: options.maxSteps
  });

  queue.process(async (jobId) => {
    await orchestrator.run(jobId);
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/jobs", async () => {
    return { jobs: await store.list() };
  });

  app.post("/jobs", async (request, reply) => {
    const parsed = createJobSchema.parse(request.body);
    const jobId = crypto.randomUUID();
    const workspacePath = await sandbox.prepare(jobId);
    await sandbox.importDirectory(jobId, parsed.sourcePath ?? options.defaultSourcePath ?? process.cwd());
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

function createSandbox(options: AppOptions): Sandbox {
  if (options.sandboxDriver === "docker") {
    return new DockerSandbox({
      rootDir: options.sandboxRoot,
      image: options.sandboxImage ?? "cloud-agent-sandbox:latest",
      cpus: options.sandboxCpus,
      memory: options.sandboxMemory,
      network: options.sandboxNetwork ?? "none",
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
