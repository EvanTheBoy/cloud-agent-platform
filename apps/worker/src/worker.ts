import { loadEnvFile } from "../../api/src/env.js";
import { loadRuntimeConfig } from "../../api/src/config.js";
import { closeAgentRuntime, createAgentRuntime } from "../../api/src/runtime.js";

loadEnvFile();

const config = loadRuntimeConfig();

if (config.queueDriver !== "bullmq") {
  throw new Error("Worker process requires QUEUE_DRIVER=bullmq");
}

if (config.storeDriver !== "postgres") {
  throw new Error("Worker process requires STORE_DRIVER=postgres");
}

const runtime = await createAgentRuntime(config);
let closing = false;

runtime.queue.process(async (jobId) => {
  return runtime.orchestrator.run(jobId);
});

console.log("Worker started", {
  queueDriver: config.queueDriver,
  storeDriver: config.storeDriver,
  jobConcurrency: config.jobConcurrency
});

const shutdown = async (signal: NodeJS.Signals) => {
  if (closing) {
    return;
  }
  closing = true;
  console.log(`Received ${signal}, shutting down worker`);
  await closeAgentRuntime(runtime);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT").then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => process.exit(0));
});
