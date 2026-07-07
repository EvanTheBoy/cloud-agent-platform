import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { z } from "zod";
import { createRootTraceContext, diagnosticTextFields, tracePayloadFields } from "../../../packages/agent-core/src/index.js";
import type { MetricsRecorder } from "../../../packages/agent-core/src/index.js";
import { closeAgentRuntime, createApiRuntime, createWorkerRuntime } from "./runtime.js";
import type { ApiRuntime, WorkerRuntime } from "./runtime.js";

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
  queueRemoveOnCompleteAge?: number;
  queueRemoveOnCompleteCount?: number;
  queueRemoveOnFailAge?: number;
  queueRemoveOnFailCount?: number;
  maxSteps: number;
  defaultSourcePath?: string;
  allowedSourceRoot?: string;
  processJobsInApi?: boolean;
  metrics?: MetricsRecorder;
}

export async function buildApp(options: AppOptions) {
  if (options.queueDriver === "bullmq" && options.processJobsInApi) {
    throw new Error("BullMQ jobs must be processed by the separate worker process");
  }

  if (options.queueDriver === "bullmq" && !options.processJobsInApi && options.storeDriver !== "postgres") {
    throw new Error("BullMQ API/worker mode requires STORE_DRIVER=postgres");
  }

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const runtime = options.processJobsInApi ? await createWorkerRuntime(options) : await createApiRuntime(options);
  const { store, queue, sandbox } = runtime;

  if (isWorkerRuntime(runtime)) {
    queue.process(async (jobId, traceContext) => {
      return runtime.orchestrator.run(jobId, traceContext);
    });
  }

  app.addHook("onClose", async () => {
    await closeAgentRuntime(runtime);
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/metrics", async (_request, reply) => {
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(runtime.metrics.renderPrometheus?.() ?? "");
  });

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
    const traceContext = createRootTraceContext();
    const workspacePath = await sandbox.prepare(jobId);
    await sandbox.importDirectory(jobId, sourcePath);
    const job = await store.create({ id: jobId, task: parsed.task, workspacePath, traceContext });
    try {
      await queue.enqueue(job.id, traceContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedJob = await store.update(job.id, {
        status: "failed",
        error: `Failed to enqueue job: ${message}`
      }, traceContext);
      await store.appendEvent({
        type: "job.finished",
        jobId: job.id,
        timestamp: new Date().toISOString(),
        payload: {
          status: failedJob.status,
          ...tracePayloadFields(traceContext),
          ...diagnosticTextFields("error", failedJob.error ?? ""),
          failureKind: "enqueue"
        }
      });
      return reply.code(503).send({ error: "Failed to enqueue job", job: failedJob });
    }
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

function isWorkerRuntime(runtime: ApiRuntime | WorkerRuntime): runtime is WorkerRuntime {
  return "orchestrator" in runtime;
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
