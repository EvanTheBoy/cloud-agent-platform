import { resolve } from "node:path";
import type { AppOptions } from "./app.js";

export interface ServerConfig extends AppOptions {
  port: number;
}

export function loadServerConfig(): ServerConfig {
  const defaultSourcePath = resolve(process.env.DEFAULT_SOURCE_PATH ?? process.cwd());
  return {
    port: parsePositiveIntegerEnv("PORT", 8080),
    ...loadRuntimeConfig(defaultSourcePath)
  };
}

export function loadRuntimeConfig(defaultSourcePath = resolve(process.env.DEFAULT_SOURCE_PATH ?? process.cwd())): AppOptions {
  return {
    sandboxRoot: resolve(process.env.SANDBOX_ROOT ?? "./workspace-runs"),
    sandboxDriver: parseSandboxDriver(process.env.SANDBOX_DRIVER),
    sandboxImage: process.env.SANDBOX_IMAGE ?? "cloud-agent-sandbox:latest",
    sandboxCpus: process.env.SANDBOX_CPUS,
    sandboxMemory: process.env.SANDBOX_MEMORY,
    sandboxNetwork: parseSandboxNetwork(process.env.SANDBOX_NETWORK),
    sandboxUser: process.env.SANDBOX_USER,
    sandboxPidsLimit: parseOptionalPositiveIntegerEnv("SANDBOX_PIDS_LIMIT"),
    sandboxTimeoutMs: parseOptionalPositiveIntegerEnv("SANDBOX_TIMEOUT_MS"),
    queueDriver: parseQueueDriver(process.env.QUEUE_DRIVER),
    redisUrl: process.env.REDIS_URL,
    storeDriver: parseStoreDriver(process.env.STORE_DRIVER),
    databaseUrl: process.env.DATABASE_URL,
    jobConcurrency: parsePositiveIntegerEnv("JOB_CONCURRENCY", 2),
    jobMaxAttempts: parsePositiveIntegerEnv("JOB_MAX_ATTEMPTS", 3),
    maxSteps: parsePositiveIntegerEnv("AGENT_MAX_STEPS", 8),
    defaultSourcePath,
    allowedSourceRoot: resolve(process.env.SANDBOX_SOURCE_ROOT ?? defaultSourcePath)
  };
}

function parseSandboxDriver(value: string | undefined): "local" | "docker" {
  if (!value || value === "local") {
    return "local";
  }
  if (value === "docker") {
    return "docker";
  }
  throw new Error(`Invalid SANDBOX_DRIVER: ${value}`);
}

function parseQueueDriver(value: string | undefined): "memory" | "bullmq" {
  if (!value || value === "memory") {
    return "memory";
  }
  if (value === "bullmq") {
    return "bullmq";
  }
  throw new Error(`Invalid QUEUE_DRIVER: ${value}`);
}

function parseStoreDriver(value: string | undefined): "memory" | "postgres" {
  if (!value || value === "memory") {
    return "memory";
  }
  if (value === "postgres") {
    return "postgres";
  }
  throw new Error(`Invalid STORE_DRIVER: ${value}`);
}

function parseSandboxNetwork(value: string | undefined): "none" | "bridge" | "host" | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "none" || value === "bridge" || value === "host") {
    return value;
  }
  throw new Error(`Invalid SANDBOX_NETWORK: ${value}`);
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  return parsePositiveInteger(name, process.env[name] ?? String(fallback));
}

function parseOptionalPositiveIntegerEnv(name: string): number | undefined {
  const value = process.env[name];
  return value ? parsePositiveInteger(name, value) : undefined;
}

function parsePositiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}
