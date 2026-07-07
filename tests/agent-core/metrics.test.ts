import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryMetricsRecorder, InstrumentedJobStore } from "../../packages/agent-core/src/index.js";
import type { AgentJob, CreateJobInput, JobEvent, JobStore } from "../../packages/agent-core/src/types.js";

describe("InMemoryMetricsRecorder", () => {
  it("renders counters, gauges, and observation summaries as Prometheus text", () => {
    const metrics = new InMemoryMetricsRecorder();

    metrics.increment("agent_jobs_total", { status: "succeeded" });
    metrics.increment("agent_jobs_total", { status: "succeeded" });
    metrics.gauge("agent_queue_depth", 3, { driver: "memory" });
    metrics.observe("agent_tool_duration_ms", 12, { toolName: "shell.exec", outcome: "success" });
    metrics.observe("agent_tool_duration_ms", 8, { toolName: "shell.exec", outcome: "success" });

    const rendered = metrics.renderPrometheus();

    assert.match(rendered, /agent_jobs_total\{status="succeeded"\} 2/);
    assert.match(rendered, /agent_queue_depth\{driver="memory"\} 3/);
    assert.match(rendered, /agent_tool_duration_ms_count\{outcome="success",toolName="shell\.exec"\} 2/);
    assert.match(rendered, /agent_tool_duration_ms_sum\{outcome="success",toolName="shell\.exec"\} 20/);
  });

  it("escapes label values and normalizes metric names", () => {
    const metrics = new InMemoryMetricsRecorder();

    metrics.increment("1.invalid-name", { "bad-label": "quote\" newline\n slash\\", missing: undefined });

    assert.equal(metrics.renderPrometheus(), '_1_invalid_name{bad_label="quote\\" newline\\n slash\\\\"} 1\n');
  });

  it("keeps distinct label sets separate when values contain key delimiters", () => {
    const metrics = new InMemoryMetricsRecorder();

    metrics.increment("agent_collision_total", { a: "b,c=d" });
    metrics.increment("agent_collision_total", { a: "b", c: "d" });

    const rendered = metrics.renderPrometheus();
    assert.match(rendered, /agent_collision_total\{a="b",c="d"\} 1/);
    assert.match(rendered, /agent_collision_total\{a="b,c=d"\} 1/);
  });
});

describe("InstrumentedJobStore", () => {
  it("records store operation failures without swallowing the original error", async () => {
    const metrics = new InMemoryMetricsRecorder();
    const store = new InstrumentedJobStore(new ThrowingStore(), metrics, "test");

    await assert.rejects(() => store.get("job-1"), /store down/);

    const rendered = metrics.renderPrometheus();
    assert.match(rendered, /agent_store_operation_duration_ms_count\{driver="test",operation="get",outcome="failure"\} 1/);
    assert.match(rendered, /agent_store_operation_failures_total\{driver="test",operation="get"\} 1/);
  });
});

class ThrowingStore implements JobStore {
  async create(_input: CreateJobInput & { workspacePath: string }): Promise<AgentJob> {
    throw new Error("store down");
  }

  async get(): Promise<AgentJob | undefined> {
    throw new Error("store down");
  }

  async update(): Promise<AgentJob> {
    throw new Error("store down");
  }

  async list(): Promise<AgentJob[]> {
    throw new Error("store down");
  }

  async appendEvent(_event: JobEvent): Promise<void> {
    throw new Error("store down");
  }

  async getEvents(): Promise<JobEvent[]> {
    throw new Error("store down");
  }
}
