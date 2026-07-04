import { EventEmitter } from "node:events";
import { Queue, Worker } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import type { JobHandler, JobQueue } from "./types.js";

export type QueueEventType = "queue.enqueued" | "queue.active" | "queue.completed" | "queue.failed";

export interface QueueEvent {
  type: QueueEventType;
  jobId: string;
  payload?: Record<string, unknown>;
}

export type QueueEventHandler = (event: QueueEvent) => void | Promise<void>;

export class InMemoryJobQueue implements JobQueue {
  private readonly events = new EventEmitter();
  private active = 0;
  private readonly pending: string[] = [];

  constructor(
    private readonly concurrency = 2,
    private readonly onEvent?: QueueEventHandler
  ) {}

  async enqueue(jobId: string): Promise<void> {
    this.pending.push(jobId);
    this.emitEvent({ type: "queue.enqueued", jobId });
    queueMicrotask(() => this.drain());
  }

  process(handler: JobHandler): void {
    this.events.on("job", (jobId: string) => {
      this.emitEvent({ type: "queue.active", jobId });
      void handler(jobId)
        .then(() => {
          this.emitEvent({ type: "queue.completed", jobId });
        })
        .catch((error: unknown) => {
          this.emitEvent({
            type: "queue.failed",
            jobId,
            payload: { error: error instanceof Error ? error.message : String(error) }
          });
        })
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    });
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const jobId = this.pending.shift();
      if (!jobId) {
        return;
      }
      this.active += 1;
      this.events.emit("job", jobId);
    }
  }

  private emitEvent(event: QueueEvent): void {
    void this.onEvent?.(event);
  }
}

export interface BullMqJobQueueOptions {
  redisUrl: string;
  concurrency?: number;
  maxAttempts?: number;
  queueName?: string;
  onEvent?: QueueEventHandler;
}

export class BullMqJobQueue implements JobQueue {
  private readonly connection: ConnectionOptions;
  private readonly queue: Queue<{ jobId: string }>;
  private worker?: Worker<{ jobId: string }>;
  private readonly maxAttempts: number;
  private readonly concurrency: number;
  private readonly onEvent?: QueueEventHandler;

  constructor(options: BullMqJobQueueOptions) {
    const queueName = options.queueName ?? "agent-jobs";
    this.connection = parseRedisConnection(options.redisUrl);
    this.queue = new Queue(queueName, {
      connection: this.connection
    });
    this.maxAttempts = options.maxAttempts ?? 3;
    this.concurrency = options.concurrency ?? 2;
    this.onEvent = options.onEvent;
  }

  async enqueue(jobId: string): Promise<void> {
    await this.queue.add(
      "agent-job",
      { jobId },
      {
        jobId,
        attempts: this.maxAttempts,
        backoff: {
          type: "exponential",
          delay: 1_000
        },
        removeOnComplete: false,
        removeOnFail: false
      }
    );
    this.emitEvent({
      type: "queue.enqueued",
      jobId,
      payload: { driver: "bullmq", maxAttempts: this.maxAttempts }
    });
  }

  process(handler: JobHandler): void {
    if (this.worker) {
      throw new Error("BullMQ processor has already been registered");
    }

    this.worker = new Worker<{ jobId: string }>(
      this.queue.name,
      async (job) => {
        const jobId = job.data.jobId;
        this.emitEvent({
          type: "queue.active",
          jobId,
          payload: { driver: "bullmq", attempt: job.attemptsMade + 1 }
        });
        await handler(jobId);
      },
      {
        connection: this.connection,
        concurrency: this.concurrency
      }
    );

    this.worker.on("completed", (job) => {
      this.emitEvent({
        type: "queue.completed",
        jobId: job.data.jobId,
        payload: { driver: "bullmq", attemptsMade: job.attemptsMade }
      });
    });

    this.worker.on("failed", (job, error) => {
      this.emitEvent({
        type: "queue.failed",
        jobId: job?.data.jobId ?? "unknown",
        payload: {
          driver: "bullmq",
          attemptsMade: job?.attemptsMade,
          error: error.message
        }
      });
    });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }

  private emitEvent(event: QueueEvent): void {
    void this.onEvent?.(event);
  }
}

function parseRedisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const db = url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined;
  if (db !== undefined && (!Number.isInteger(db) || db < 0)) {
    throw new Error(`Invalid Redis database in REDIS_URL: ${url.pathname}`);
  }

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db,
    maxRetriesPerRequest: null,
    ...(url.protocol === "rediss:" ? { tls: {} } : {})
  };
}
