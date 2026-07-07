import { nanoid } from "nanoid";
import type { AgentJob, CreateJobInput, JobEvent, JobStore, TraceContext } from "./types.js";
import { jobEventPayload } from "./diagnostics.js";
import { tracePayloadFields } from "./trace.js";

const now = () => new Date().toISOString();

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, AgentJob>();
  private readonly events = new Map<string, JobEvent[]>();

  async create(input: CreateJobInput & { workspacePath: string }): Promise<AgentJob> {
    const timestamp = now();
    const job: AgentJob = {
      id: input.id ?? nanoid(),
      task: input.task,
      status: "queued",
      workspacePath: input.workspacePath,
      steps: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.jobs.set(job.id, job);
    await this.appendEvent({
      type: "job.created",
      jobId: job.id,
      timestamp,
      payload: { job: jobEventPayload(job), ...tracePayloadFields(input.traceContext) }
    });
    return job;
  }

  async get(id: string): Promise<AgentJob | undefined> {
    return this.jobs.get(id);
  }

  async update(id: string, patch: Partial<Omit<AgentJob, "id" | "createdAt">>, traceContext?: TraceContext): Promise<AgentJob> {
    const existing = this.jobs.get(id);
    if (!existing) {
      throw new Error(`Job ${id} not found`);
    }

    const updated: AgentJob = {
      ...existing,
      ...patch,
      updatedAt: now()
    };
    this.jobs.set(id, updated);
    await this.appendEvent({
      type: "job.updated",
      jobId: id,
      timestamp: updated.updatedAt,
      payload: { job: jobEventPayload(updated), ...tracePayloadFields(traceContext) }
    });
    return updated;
  }

  async list(): Promise<AgentJob[]> {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async appendEvent(event: JobEvent): Promise<void> {
    const events = this.events.get(event.jobId) ?? [];
    events.push(event);
    this.events.set(event.jobId, events);
  }

  async getEvents(jobId: string): Promise<JobEvent[]> {
    return this.events.get(jobId) ?? [];
  }
}
