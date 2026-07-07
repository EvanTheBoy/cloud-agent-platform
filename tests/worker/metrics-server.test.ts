import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryMetricsRecorder } from "../../packages/agent-core/src/index.js";
import { renderWorkerMetricsResponse } from "../../apps/worker/src/metrics-server.js";

describe("worker metrics server", () => {
  it("renders worker-local metrics as Prometheus text", () => {
    const metrics = new InMemoryMetricsRecorder();
    metrics.increment("agent_worker_metric_total", { status: "succeeded" });
    const response = renderWorkerMetricsResponse(metrics, "GET", "/metrics");

    assert.equal(response.status, 200);
    assert.match(response.contentType, /text\/plain/);
    assert.match(response.body, /agent_worker_metric_total\{status="succeeded"\} 1/);
  });

  it("renders a health response", () => {
    const response = renderWorkerMetricsResponse(new InMemoryMetricsRecorder(), "GET", "/health");

    assert.equal(response.status, 200);
    assert.equal(response.contentType, "application/json; charset=utf-8");
    assert.deepEqual(JSON.parse(response.body), { ok: true });
  });

  it("renders not found for unknown routes", () => {
    const response = renderWorkerMetricsResponse(new InMemoryMetricsRecorder(), "GET", "/unknown");

    assert.equal(response.status, 404);
    assert.deepEqual(JSON.parse(response.body), { error: "not_found" });
  });
});
