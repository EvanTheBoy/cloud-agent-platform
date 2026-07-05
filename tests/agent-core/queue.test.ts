import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryJobQueue } from "../../packages/agent-core/src/queue.js";
import { parseRedisConnection } from "../../packages/agent-core/src/redis-connection.js";
import type { QueueEvent } from "../../packages/agent-core/src/queue.js";

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

async function waitForEvents(events: QueueEvent[], count: number): Promise<void> {
  const deadline = Date.now() + 250;
  while (events.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
