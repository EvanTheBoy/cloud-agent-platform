import { nanoid } from "nanoid";
import pg from "pg";
import type { AgentJob, AgentStep, CreateJobInput, JobEvent, JobEventType, JobStatus, JobStore, TraceContext } from "./types.js";
import { jobEventPayload } from "./diagnostics.js";
import { tracePayloadFields } from "./trace.js";

const { Pool } = pg;

const now = () => new Date().toISOString();

export const POSTGRES_JOB_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  task text NOT NULL,
  status text NOT NULL,
  workspace_path text NOT NULL,
  steps_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  result text,
  error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);
CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS job_events (
  id bigserial PRIMARY KEY,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS job_events_job_id_id_idx ON job_events (job_id, id);
`;

export interface PostgresJobStoreOptions {
  connectionString: string;
  runMigrations?: boolean;
}

export class PostgresJobStore implements JobStore {
  private readonly pool: pg.Pool;

  constructor(options: PostgresJobStoreOptions) {
    this.pool = new Pool({ connectionString: options.connectionString });
  }

  static async create(options: PostgresJobStoreOptions): Promise<PostgresJobStore> {
    const store = new PostgresJobStore(options);
    try {
      if (options.runMigrations ?? true) {
        await store.migrate();
      }
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  async migrate(): Promise<void> {
    await this.pool.query(POSTGRES_JOB_STORE_SCHEMA);
  }

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

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
        INSERT INTO jobs (id, task, status, workspace_path, steps_json, result, error, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
        `,
        [
          job.id,
          job.task,
          job.status,
          job.workspacePath,
          JSON.stringify(job.steps),
          job.result ?? null,
          job.error ?? null,
          job.createdAt,
          job.updatedAt
        ]
      );
      await insertEvent(client, {
        type: "job.created",
        jobId: job.id,
        timestamp,
        payload: { job: jobEventPayload(job), ...tracePayloadFields(input.traceContext) }
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return job;
  }

  async get(id: string): Promise<AgentJob | undefined> {
    const result = await this.pool.query<JobRow>("SELECT * FROM jobs WHERE id = $1", [id]);
    const row = result.rows[0];
    return row ? rowToJob(row) : undefined;
  }

  async update(id: string, patch: Partial<Omit<AgentJob, "id" | "createdAt">>, traceContext?: TraceContext): Promise<AgentJob> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existingResult = await client.query<JobRow>("SELECT * FROM jobs WHERE id = $1 FOR UPDATE", [id]);
      const existingRow = existingResult.rows[0];
      if (!existingRow) {
        throw new Error(`Job ${id} not found`);
      }

      const existing = rowToJob(existingRow);
      const updated: AgentJob = {
        ...existing,
        ...patch,
        updatedAt: now()
      };

      await client.query(
        `
        UPDATE jobs
        SET task = $2,
            status = $3,
            workspace_path = $4,
            steps_json = $5::jsonb,
            result = $6,
            error = $7,
            updated_at = $8
        WHERE id = $1
        `,
        [
          updated.id,
          updated.task,
          updated.status,
          updated.workspacePath,
          JSON.stringify(updated.steps),
          updated.result ?? null,
          updated.error ?? null,
          updated.updatedAt
        ]
      );

      await insertEvent(client, {
        type: "job.updated",
        jobId: id,
        timestamp: updated.updatedAt,
        payload: { job: jobEventPayload(updated), ...tracePayloadFields(traceContext) }
      });
      await client.query("COMMIT");
      return updated;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async list(): Promise<AgentJob[]> {
    const result = await this.pool.query<JobRow>("SELECT * FROM jobs ORDER BY created_at DESC");
    return result.rows.map(rowToJob);
  }

  async appendEvent(event: JobEvent): Promise<void> {
    await insertEvent(this.pool, event);
  }

  async getEvents(jobId: string): Promise<JobEvent[]> {
    const result = await this.pool.query<JobEventRow>(
      "SELECT * FROM job_events WHERE job_id = $1 ORDER BY id ASC",
      [jobId]
    );
    return result.rows.map(rowToEvent);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

async function insertEvent(queryable: Queryable, event: JobEvent): Promise<void> {
  await queryable.query(
    `
    INSERT INTO job_events (job_id, type, payload_json, created_at)
    VALUES ($1, $2, $3::jsonb, $4)
    `,
    [event.jobId, event.type, JSON.stringify(event.payload), event.timestamp]
  );
}

interface Queryable {
  query: pg.Pool["query"];
}

interface JobRow {
  id: string;
  task: string;
  status: JobStatus;
  workspace_path: string;
  steps_json: AgentStep[] | string;
  result: string | null;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface JobEventRow {
  job_id: string;
  type: JobEventType;
  payload_json: Record<string, unknown> | string;
  created_at: Date | string;
}

function rowToJob(row: JobRow): AgentJob {
  return {
    id: row.id,
    task: row.task,
    status: row.status,
    workspacePath: row.workspace_path,
    steps: parseJsonValue<AgentStep[]>(row.steps_json, []),
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function rowToEvent(row: JobEventRow): JobEvent {
  return {
    type: row.type,
    jobId: row.job_id,
    timestamp: toIsoString(row.created_at),
    payload: parseJsonValue<Record<string, unknown>>(row.payload_json, {})
  };
}

function parseJsonValue<T>(value: T | string, fallback: T): T {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
