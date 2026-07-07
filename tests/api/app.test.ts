import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { InMemoryMetricsRecorder } from "../../packages/agent-core/src/index.js";
import { buildApp } from "../../apps/api/src/app.js";
import { closeAgentRuntime, createApiRuntime } from "../../apps/api/src/runtime.js";

describe("buildApp", () => {
  it("rejects BullMQ inline processing in the API process", async () => {
    await assert.rejects(
      () =>
        buildApp({
          sandboxRoot: "/tmp/cloud-agent-platform-test",
          queueDriver: "bullmq",
          redisUrl: "redis://127.0.0.1:6379",
          storeDriver: "postgres",
          databaseUrl: "postgres://user:pass@127.0.0.1:5432/cloud_agent_platform_test",
          maxSteps: 1,
          processJobsInApi: true
        }),
      /BullMQ jobs must be processed by the separate worker process/
    );
  });

  it("exposes in-process metrics as Prometheus text", async () => {
    const metrics = new InMemoryMetricsRecorder();
    metrics.increment("agent_jobs_total", { status: "succeeded" });
    const app = await buildApp({
      sandboxRoot: await mkdtemp(join(tmpdir(), "cloud-agent-platform-test-")),
      maxSteps: 1,
      processJobsInApi: false,
      metrics
    });

    try {
      const response = await app.inject({ method: "GET", url: "/metrics" });

      assert.equal(response.statusCode, 200);
      assert.match(response.headers["content-type"] as string, /text\/plain/);
      assert.match(response.body, /agent_jobs_total\{status="succeeded"\} 1/);
    } finally {
      await app.close();
    }
  });

  it("records queue terminal metrics with finalStatus as the status label", async () => {
    const metrics = new InMemoryMetricsRecorder();
    const runtime = await createApiRuntime({
      sandboxRoot: await mkdtemp(join(tmpdir(), "cloud-agent-platform-test-")),
      maxSteps: 1,
      metrics
    });

    try {
      runtime.queue.process(async () => ({ status: "succeeded" }));
      await runtime.queue.enqueue("job-1");

      await eventually(() => {
        assert.match(
          metrics.renderPrometheus(),
          /agent_queue_events_total\{driver="memory",event="completed",status="succeeded"\} 1/
        );
      });
    } finally {
      await closeAgentRuntime(runtime);
    }
  });
});

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await delay(10);
    }
  }
  throw lastError;
}
