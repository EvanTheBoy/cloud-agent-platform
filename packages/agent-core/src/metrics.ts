import type { AgentJob, CreateJobInput, JobEvent, JobStore } from "./types.js";

export type MetricLabels = Record<string, string | number | boolean | undefined>;

export interface MetricsRecorder {
  increment(name: string, labels?: MetricLabels, value?: number): void;
  observe(name: string, value: number, labels?: MetricLabels): void;
  gauge(name: string, value: number, labels?: MetricLabels): void;
  renderPrometheus?(): string;
}

export class NoopMetricsRecorder implements MetricsRecorder {
  increment(): void {}
  observe(): void {}
  gauge(): void {}
}

export const noopMetricsRecorder = new NoopMetricsRecorder();

interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

interface ObservationSample {
  name: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
}

export class InMemoryMetricsRecorder implements MetricsRecorder {
  private readonly counters = new Map<string, MetricSample>();
  private readonly gauges = new Map<string, MetricSample>();
  private readonly observations = new Map<string, ObservationSample>();

  increment(name: string, labels: MetricLabels = {}, value = 1): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const sample = this.getCounter(name, labels);
    sample.value += value;
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const sample = this.getObservation(name, labels);
    sample.count += 1;
    sample.sum += value;
  }

  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const normalized = normalizeSample(name, labels);
    this.gauges.set(metricKey(normalized.name, normalized.labels), {
      ...normalized,
      value
    });
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const sample of sortedSamples(this.counters.values())) {
      lines.push(formatPrometheusSample(sample.name, sample.labels, sample.value));
    }
    for (const sample of sortedSamples(this.gauges.values())) {
      lines.push(formatPrometheusSample(sample.name, sample.labels, sample.value));
    }
    for (const sample of sortedSamples(this.observations.values())) {
      lines.push(formatPrometheusSample(`${sample.name}_count`, sample.labels, sample.count));
      lines.push(formatPrometheusSample(`${sample.name}_sum`, sample.labels, sample.sum));
    }
    return `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
  }

  private getCounter(name: string, labels: MetricLabels): MetricSample {
    const normalized = normalizeSample(name, labels);
    const key = metricKey(normalized.name, normalized.labels);
    const existing = this.counters.get(key);
    if (existing) {
      return existing;
    }
    const sample = { ...normalized, value: 0 };
    this.counters.set(key, sample);
    return sample;
  }

  private getObservation(name: string, labels: MetricLabels): ObservationSample {
    const normalized = normalizeSample(name, labels);
    const key = metricKey(normalized.name, normalized.labels);
    const existing = this.observations.get(key);
    if (existing) {
      return existing;
    }
    const sample = { ...normalized, count: 0, sum: 0 };
    this.observations.set(key, sample);
    return sample;
  }
}

export function recordIncrement(metrics: MetricsRecorder | undefined, name: string, labels?: MetricLabels, value?: number): void {
  try {
    metrics?.increment(name, labels, value);
  } catch (error) {
    console.warn("Failed to record metric counter", { name, error: error instanceof Error ? error.message : String(error) });
  }
}

export function recordObservation(metrics: MetricsRecorder | undefined, name: string, value: number, labels?: MetricLabels): void {
  try {
    metrics?.observe(name, value, labels);
  } catch (error) {
    console.warn("Failed to record metric observation", { name, error: error instanceof Error ? error.message : String(error) });
  }
}

export function recordGauge(metrics: MetricsRecorder | undefined, name: string, value: number, labels?: MetricLabels): void {
  try {
    metrics?.gauge(name, value, labels);
  } catch (error) {
    console.warn("Failed to record metric gauge", { name, error: error instanceof Error ? error.message : String(error) });
  }
}

export class InstrumentedJobStore implements JobStore {
  constructor(
    private readonly inner: JobStore,
    private readonly metrics: MetricsRecorder,
    private readonly driver: string
  ) {}

  async create(input: CreateJobInput & { workspacePath: string }): Promise<AgentJob> {
    return await this.measure("create", () => this.inner.create(input));
  }

  async get(id: string): Promise<AgentJob | undefined> {
    return await this.measure("get", () => this.inner.get(id));
  }

  async list(): Promise<AgentJob[]> {
    return await this.measure("list", () => this.inner.list());
  }

  async update(id: string, patch: Partial<AgentJob>): Promise<AgentJob> {
    return await this.measure("update", () => this.inner.update(id, patch));
  }

  async appendEvent(event: JobEvent): Promise<void> {
    await this.measure("appendEvent", () => this.inner.appendEvent(event));
  }

  async getEvents(jobId: string): Promise<JobEvent[]> {
    return await this.measure("getEvents", () => this.inner.getEvents(jobId));
  }

  async close(): Promise<void> {
    await this.measure("close", async () => {
      await this.inner.close?.();
    });
  }

  private async measure<T>(operation: string, run: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await run();
      recordObservation(this.metrics, "agent_store_operation_duration_ms", Date.now() - startedAt, {
        driver: this.driver,
        operation,
        outcome: "success"
      });
      return result;
    } catch (error) {
      recordObservation(this.metrics, "agent_store_operation_duration_ms", Date.now() - startedAt, {
        driver: this.driver,
        operation,
        outcome: "failure"
      });
      recordIncrement(this.metrics, "agent_store_operation_failures_total", {
        driver: this.driver,
        operation
      });
      throw error;
    }
  }
}

function normalizeSample(name: string, labels: MetricLabels): { name: string; labels: Record<string, string> } {
  const normalizedLabels: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (value === undefined) {
      continue;
    }
    normalizedLabels[normalizeMetricName(key)] = truncateLabelValue(String(value));
  }
  return {
    name: normalizeMetricName(name),
    labels: normalizedLabels
  };
}

function normalizeMetricName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_:]/g, "_");
  return /^[a-zA-Z_:]/.test(normalized) ? normalized : `_${normalized}`;
}

function truncateLabelValue(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function metricKey(name: string, labels: Record<string, string>): string {
  return JSON.stringify([
    name,
    Object.entries(labels).sort(([left], [right]) => left.localeCompare(right))
  ]);
}

function formatPrometheusSample(name: string, labels: Record<string, string>, value: number): string {
  const labelText = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, labelValue]) => `${key}="${escapePrometheusLabel(labelValue)}"`)
    .join(",");
  return `${name}${labelText ? `{${labelText}}` : ""} ${value}`;
}

function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function sortedSamples<T extends { name: string; labels: Record<string, string> }>(samples: Iterable<T>): T[] {
  return [...samples].sort((left, right) => metricKey(left.name, left.labels).localeCompare(metricKey(right.name, right.labels)));
}
