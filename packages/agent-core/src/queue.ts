import { EventEmitter } from "node:events";
import { Queue, Worker } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { parseRedisConnection } from "./redis-connection.js";
import type { JobHandler, JobHandlerResult, JobQueue, JobStatus } from "./types.js";

export type QueueEventType =
  | "queue.enqueued"
  | "queue.active"
  | "queue.completed"
  | "queue.attempt_failed"
  | "queue.failed";

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
    await this.emitEvent({ type: "queue.enqueued", jobId });
    queueMicrotask(() => this.drain());
  }

  process(handler: JobHandler): void {
    this.events.on("job", (jobId: string) => {
      void (async () => {
        await this.emitEvent({ type: "queue.active", jobId });
        const result = await handler(jobId);
        const finalStatus = getHandlerFinalStatus(result);
        if (finalStatus === "failed") {
          await this.emitEvent({
            type: "queue.failed",
            jobId,
            payload: {
              failureKind: "business",
              finalStatus,
              error: getHandlerError(result)
            }
          });
          return;
        }
        await this.emitEvent({
          type: "queue.completed",
          jobId,
          payload: { finalStatus: finalStatus ?? "unknown" }
        });
      })()
        .catch((error: unknown) => {
          void this.emitEvent({
            type: "queue.failed",
            jobId,
            payload: { failureKind: "processor", error: errorMessage(error) }
          }).catch((emitError: unknown) => {
            console.error("Failed to record in-memory queue failed event", emitError);
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

  private async emitEvent(event: QueueEvent): Promise<void> {
    await this.onEvent?.(event);
  }
}

export interface BullMqJobQueueOptions {
  redisUrl: string;
  concurrency?: number;
  maxAttempts?: number;
  queueName?: string;
  removeOnComplete?: BullMqJobRetention;
  removeOnFail?: BullMqJobRetention;
  onEvent?: QueueEventHandler;
}

export class BullMqJobQueue implements JobQueue {
  private readonly connection: ConnectionOptions;
  private readonly queue: Queue<{ jobId: string }, QueueHandlerResult>;
  private worker?: Worker<{ jobId: string }, QueueHandlerResult>;
  private readonly maxAttempts: number;
  private readonly concurrency: number;
  private readonly removeOnComplete: BullMqJobRetention;
  private readonly removeOnFail: BullMqJobRetention;
  private readonly onEvent?: QueueEventHandler;

  constructor(options: BullMqJobQueueOptions) {
    const queueName = options.queueName ?? "agent-jobs";
    this.connection = parseRedisConnection(options.redisUrl);
    this.queue = new Queue<{ jobId: string }, QueueHandlerResult>(queueName, {
      connection: this.connection
    });
    this.queue.on("error", (error) => {
      console.error("BullMQ queue error", error);
    });
    this.maxAttempts = options.maxAttempts ?? 3;
    this.concurrency = options.concurrency ?? 2;
    this.removeOnComplete = options.removeOnComplete ?? false;
    this.removeOnFail = options.removeOnFail ?? false;
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
        removeOnComplete: this.removeOnComplete,
        removeOnFail: this.removeOnFail
      }
    );
    await this.emitEventSafely({
      type: "queue.enqueued",
      jobId,
      payload: { driver: "bullmq", maxAttempts: this.maxAttempts }
    });
  }

  process(handler: JobHandler): void {
    if (this.worker) {
      throw new Error("BullMQ processor has already been registered");
    }

    this.worker = new Worker<{ jobId: string }, QueueHandlerResult>(
      this.queue.name,
      async (job) => {
        return this.processJob(job, handler);
      },
      {
        connection: this.connection,
        concurrency: this.concurrency
      }
    );

    this.worker.on("error", (error) => {
      console.error("BullMQ worker error", error);
    });

    this.worker.on("completed", (job) => {
      const finalStatus = job.returnvalue?.finalStatus;
      const failed = finalStatus === "failed";
      void this.emitEvent({
        type: failed ? "queue.failed" : "queue.completed",
        jobId: job.data.jobId,
        payload: {
          driver: "bullmq",
          attemptsMade: job.attemptsMade,
          finalStatus: finalStatus ?? "unknown",
          ...(failed
            ? {
                failureKind: "business",
                error: job.returnvalue?.error
              }
            : {})
        }
      }).catch((error: unknown) => {
        console.error("Failed to record BullMQ completed event", error);
      });
    });

    this.worker.on("failed", (job, error) => {
      const attemptsMade = job?.attemptsMade;
      const maxAttempts = job?.opts.attempts ?? this.maxAttempts;
      const willRetry =
        typeof attemptsMade === "number" && typeof maxAttempts === "number" && attemptsMade < maxAttempts;

      void this.emitEvent({
        type: willRetry ? "queue.attempt_failed" : "queue.failed",
        jobId: job?.data.jobId ?? "unknown",
        payload: {
          driver: "bullmq",
          attemptsMade,
          maxAttempts,
          willRetry,
          failureKind: "processor",
          error: error.message
        }
      }).catch((emitError: unknown) => {
        console.error("Failed to record BullMQ failed event", emitError);
      });
    });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }

  private async emitEvent(event: QueueEvent): Promise<void> {
    await this.onEvent?.(event);
  }

  private async emitEventSafely(event: QueueEvent): Promise<void> {
    try {
      await this.emitEvent(event);
    } catch (error) {
      console.error("Failed to record BullMQ queue event", { event, error });
    }
  }

  private async processJob(
    job: { data: { jobId: string }; attemptsMade: number },
    handler: JobHandler
  ): Promise<QueueHandlerResult> {
    const jobId = job.data.jobId;
    await this.emitEventSafely({
      type: "queue.active",
      jobId,
      payload: { driver: "bullmq", attempt: job.attemptsMade + 1 }
    });
    const result = await handler(jobId);
    return {
      finalStatus: getHandlerFinalStatus(result),
      error: getHandlerError(result)
    };
  }
}

interface QueueHandlerResult {
  finalStatus?: JobStatus;
  error?: string;
}

export type BullMqJobRetention = false | { age: number; count?: number } | { count: number };

function getHandlerFinalStatus(result: JobHandlerResult): JobStatus | undefined {
  return result && "status" in result ? result.status : undefined;
}

function getHandlerError(result: JobHandlerResult): string | undefined {
  return result && "error" in result ? result.error : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
