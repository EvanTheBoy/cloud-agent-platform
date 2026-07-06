import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BullMqJobQueue, InMemoryJobQueue } from "../../packages/agent-core/src/queue.js";
import { parseRedisConnection } from "../../packages/agent-core/src/redis-connection.js";
import type { QueueEvent } from "../../packages/agent-core/src/queue.js";
import type { JobHandler, JobHandlerResult } from "../../packages/agent-core/src/types.js";

describe("InMemoryJobQueue", () => {
  it("records business failures as queue.failed instead of queue.completed", async () => {
    const events: QueueEvent[] = [];
    const queue = new InMemoryJobQueue(1, async (event) => {
      events.push(event);
    });

    queue.process(async () => ({ status: "failed", error: "LLM failed" }));
    await queue.enqueue("job-1");
    await waitForEvents(events, 3);

    assert.deepEqual(
      events.map((event) => event.type),
      ["queue.enqueued", "queue.active", "queue.failed"]
    );
    assert.equal(events[2]?.payload?.failureKind, "business");
    assert.equal(events[2]?.payload?.finalStatus, "failed");
  });

  it("includes final job status on queue.completed", async () => {
    const events: QueueEvent[] = [];
    const queue = new InMemoryJobQueue(1, async (event) => {
      events.push(event);
    });

    queue.process(async () => ({ status: "succeeded" }));
    await queue.enqueue("job-1");
    await waitForEvents(events, 3);

    assert.equal(events[2]?.type, "queue.completed");
    assert.equal(events[2]?.payload?.finalStatus, "succeeded");
  });
});

describe("parseRedisConnection", () => {
  it("accepts redis and rediss URLs", () => {
    assert.deepEqual(parseRedisConnection("redis://user:pass@127.0.0.1:6380/2"), {
      host: "127.0.0.1",
      port: 6380,
      username: "user",
      password: "pass",
      db: 2,
      maxRetriesPerRequest: null
    });

    assert.deepEqual(parseRedisConnection("rediss://[::1]:6379/0"), {
      host: "::1",
      port: 6379,
      username: undefined,
      password: undefined,
      db: 0,
      maxRetriesPerRequest: null,
      tls: {}
    });
  });

  it("rejects invalid Redis URLs", () => {
    assert.throws(() => parseRedisConnection("http://127.0.0.1:6379"), /protocol/);
    assert.throws(() => parseRedisConnection("redis:///0"), /host/);
    assert.throws(() => parseRedisConnection("redis://127.0.0.1:0"), /port/);
    assert.throws(() => parseRedisConnection("redis://127.0.0.1:6379/not-a-db"), /database/);
  });
});

describe("BullMqJobQueue", () => {
  it("runs the handler when recording queue.active fails", async () => {
    const queue = Object.create(BullMqJobQueue.prototype) as unknown as {
      emitEvent: () => Promise<void>;
      processJob: (
        job: { data: { jobId: string }; attemptsMade: number },
        handler: JobHandler
      ) => Promise<JobHandlerResult>;
    };
    const originalConsoleError = console.error;
    let handledJobId: string | undefined;
    queue.emitEvent = async () => {
      throw new Error("store unavailable");
    };

    let result: JobHandlerResult;
    try {
      console.error = () => {};
      result = await queue.processJob({ data: { jobId: "job-1" }, attemptsMade: 0 }, async (jobId) => {
        handledJobId = jobId;
        return { status: "succeeded" };
      });
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(handledJobId, "job-1");
    assert.deepEqual(result, { finalStatus: "succeeded", error: undefined });
  });

  it("does not fail enqueue after Redis add succeeds when recording queue.enqueued fails", async () => {
    const queue = Object.create(BullMqJobQueue.prototype) as unknown as {
      queue: { add: (...args: unknown[]) => Promise<void> };
      maxAttempts: number;
      removeOnComplete: false | { age: number; count?: number } | { count: number };
      removeOnFail: false | { age: number; count?: number } | { count: number };
      emitEvent: () => Promise<void>;
      enqueue: BullMqJobQueue["enqueue"];
    };
    const calls: unknown[][] = [];
    const originalConsoleError = console.error;
    queue.queue = {
      add: async (...args: unknown[]) => {
        calls.push(args);
      }
    };
    queue.maxAttempts = 3;
    queue.removeOnComplete = { age: 3600, count: 1000 };
    queue.removeOnFail = { age: 86400, count: 5000 };
    queue.emitEvent = async () => {
      throw new Error("store unavailable");
    };

    try {
      console.error = () => {};
      await queue.enqueue("job-1");
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.[2], {
      jobId: "job-1",
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1_000
      },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400, count: 5000 }
    });
  });
});

async function waitForEvents(events: QueueEvent[], count: number): Promise<void> {
  const deadline = Date.now() + 250;
  while (events.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
