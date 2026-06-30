import { EventEmitter } from "node:events";
import type { JobQueue } from "./types.js";

export type JobHandler = (jobId: string) => Promise<void>;

export class InMemoryJobQueue implements JobQueue {
  private readonly events = new EventEmitter();
  private active = 0;
  private readonly pending: string[] = [];

  constructor(private readonly concurrency = 2) {}

  async enqueue(jobId: string): Promise<void> {
    this.pending.push(jobId);
    queueMicrotask(() => this.drain());
  }

  process(handler: JobHandler): void {
    this.events.on("job", (jobId: string) => {
      void handler(jobId).finally(() => {
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
}
