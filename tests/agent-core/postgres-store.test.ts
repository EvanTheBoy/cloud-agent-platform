import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresJobStore } from "../../packages/agent-core/src/postgres-store.js";
import type { AgentStep } from "../../packages/agent-core/src/types.js";

const databaseUrl = process.env.DATABASE_URL;

describe("PostgresJobStore", { skip: databaseUrl ? false : "DATABASE_URL is not set" }, () => {
  it("persists jobs, updates, JSONB steps, and events in insertion order", async () => {
    assert.ok(databaseUrl);
    const store = await PostgresJobStore.create({ connectionString: databaseUrl });
    const jobId = randomUUID();

    try {
      const created = await store.create({
        id: jobId,
        task: "Persist this job",
        workspacePath: `/tmp/${jobId}`
      });
      assert.equal(created.status, "queued");

      const step: AgentStep = {
        index: 0,
        thought: "Inspect files",
        toolCall: {
          id: "tool-call-1",
          name: "shell.exec",
          input: { command: "ls" }
        },
        observation: "README.md",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z"
      };

      const updated = await store.update(jobId, {
        status: "succeeded",
        steps: [step],
        result: "done"
      });
      assert.equal(updated.status, "succeeded");
      assert.deepEqual(updated.steps, [step]);

      await store.appendEvent({
        type: "step.started",
        jobId,
        timestamp: "2026-01-01T00:00:10.000Z",
        payload: { marker: "inserted-first" }
      });
      await store.appendEvent({
        type: "step.finished",
        jobId,
        timestamp: "2026-01-01T00:00:05.000Z",
        payload: { marker: "inserted-second-with-earlier-timestamp" }
      });

      const fetched = await store.get(jobId);
      assert.equal(fetched?.result, "done");
      assert.deepEqual(fetched?.steps, [step]);

      const jobs = await store.list();
      assert.ok(jobs.some((job) => job.id === jobId));

      const events = await store.getEvents(jobId);
      assert.deepEqual(
        events.map((event) => event.type),
        ["job.created", "job.updated", "step.started", "step.finished"]
      );
      assert.deepEqual(
        events.slice(-2).map((event) => event.payload.marker),
        ["inserted-first", "inserted-second-with-earlier-timestamp"]
      );
    } finally {
      await store.close();
    }
  });
});
