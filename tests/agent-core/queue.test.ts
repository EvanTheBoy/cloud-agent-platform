import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BullMqJobQueue, InMemoryJobQueue } from "../../packages/agent-core/src/queue.js";
import { parseRedisConnection } from "../../packages/agent-core/src/redis-connection.js";
import { createRootTraceContext } from "../../packages/agent-core/src/trace.js";
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

  it("propagates trace context from enqueue to worker events and handler", async () => {
    const events: QueueEvent[] = [];
    const rootTraceContext = createRootTraceContext();
    let handlerTraceContext;
    const queue = new InMemoryJobQueue(1, async (event) => {
      events.push(event);
    });

    queue.process(async (_jobId, traceContext) => {
      handlerTraceContext = traceContext;
      return { status: "succeeded" };
    });
    await queue.enqueue("job-1", rootTraceContext);
    await waitForEvents(events, 3);

    const queueTraceContext = events[0]?.traceContext;
    const workerTraceContext = events[1]?.traceContext;

    assert.equal(queueTraceContext?.traceId, rootTraceContext.traceId);
    assert.equal(queueTraceContext?.parentSpanId, rootTraceContext.spanId);
    assert.equal(workerTraceContext?.traceId, rootTraceContext.traceId);
    assert.equal(workerTraceContext?.parentSpanId, queueTraceContext?.spanId);
    assert.deepEqual(handlerTraceContext, workerTraceContext);
    assert.deepEqual(events[2]?.traceContext, workerTraceContext);
  });

  it("runs the handler when recording queue.active fails", async () => {
    const originalConsoleError = console.error;
    let handledJobId: string | undefined;
    const queue = new InMemoryJobQueue(1, async (event) => {
      if (event.type === "queue.active") {
        throw new Error("store unavailable");
      }
    });

    try {
      console.error = () => {};
      queue.process(async (jobId) => {
        handledJobId = jobId;
        return { status: "succeeded" };
      });
      await queue.enqueue("job-1");
      await eventually(() => {
        assert.equal(handledJobId, "job-1");
      });
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("does not turn handler success into queue.failed when recording queue.completed fails", async () => {
    const events: QueueEvent[] = [];
    const originalConsoleError = console.error;
    const queue = new InMemoryJobQueue(1, async (event) => {
      events.push(event);
      if (event.type === "queue.completed") {
        throw new Error("store unavailable");
      }
    });

    try {
      console.error = () => {};
      queue.process(async () => ({ status: "succeeded" }));
      await queue.enqueue("job-1");
      await waitForEvents(events, 3);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      console.error = originalConsoleError;
    }

    assert.deepEqual(
      events.map((event) => event.type),
      ["queue.enqueued", "queue.active", "queue.completed"]
    );
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
    assert.equal(result?.status, undefined);
    assert.equal("finalStatus" in (result as Record<string, unknown>), true);
    assert.equal((result as Record<string, unknown>).finalStatus, "succeeded");
    assert.equal((result as Record<string, unknown>).error, undefined);
    assert.equal(typeof (result as Record<string, unknown>).traceContext, "object");
  });

  it("preserves the original processor error when trace tagging fails", async () => {
    const queue = Object.create(BullMqJobQueue.prototype) as unknown as {
      emitEvent: () => Promise<void>;
      processJob: (
        job: { data: { jobId: string; traceContext?: { traceId: string; spanId: string } }; attemptsMade: number },
        handler: JobHandler
      ) => Promise<JobHandlerResult>;
    };
    const frozenError = Object.freeze(new Error("original processor failure"));
    queue.emitEvent = async () => {};

    await assert.rejects(
      () =>
        queue.processJob(
          {
            data: {
              jobId: "job-1",
              traceContext: { traceId: "trace-1", spanId: "queue-span" }
            },
            attemptsMade: 0
          },
          async () => {
            throw frozenError;
          }
        ),
      /original processor failure/
    );
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

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}
