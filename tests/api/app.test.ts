import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildApp } from "../../apps/api/src/app.js";

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
});
