import { loadEnvFile } from "../../api/src/env.js";
import { loadWorkerConfig } from "../../api/src/config.js";
import { closeAgentRuntime, createWorkerRuntime } from "../../api/src/runtime.js";
import { closeWorkerMetricsServer, startWorkerMetricsServer } from "./metrics-server.js";

loadEnvFile();

const config = loadWorkerConfig();

if (config.queueDriver !== "bullmq") {
  throw new Error("Worker process requires QUEUE_DRIVER=bullmq");
}

if (config.storeDriver !== "postgres") {
  throw new Error("Worker process requires STORE_DRIVER=postgres");
}

const runtime = await createWorkerRuntime(config);
const metricsServer = await startWorkerMetricsServer(runtime.metrics, {
  host: config.metricsHost,
  port: config.metricsPort
});
let closing = false;

runtime.queue.process(async (jobId, traceContext) => {
  return runtime.orchestrator.run(jobId, traceContext);
});

console.log("Worker started", {
  queueDriver: config.queueDriver,
  storeDriver: config.storeDriver,
  jobConcurrency: config.jobConcurrency,
  metrics: `http://${config.metricsHost}:${config.metricsPort}/metrics`
});

const shutdown = async (signal: NodeJS.Signals) => {
  if (closing) {
    return;
  }
  closing = true;
  console.log(`Received ${signal}, shutting down worker`);
  await closeWorkerMetricsServer(metricsServer);
  await closeAgentRuntime(runtime);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT").then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => process.exit(0));
});
