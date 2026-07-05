import { resolve } from "node:path";
import { loadEnvFile } from "./env.js";

loadEnvFile();

const { buildApp } = await import("./app.js");

const port = parsePositiveIntegerEnv("PORT", 8080);
const sandboxRoot = resolve(process.env.SANDBOX_ROOT ?? "./workspace-runs");
const sandboxDriver = parseSandboxDriver(process.env.SANDBOX_DRIVER);
const sandboxImage = process.env.SANDBOX_IMAGE ?? "cloud-agent-sandbox:latest";
const sandboxCpus = process.env.SANDBOX_CPUS;
const sandboxMemory = process.env.SANDBOX_MEMORY;
const sandboxNetwork = parseSandboxNetwork(process.env.SANDBOX_NETWORK);
const sandboxUser = process.env.SANDBOX_USER;
const sandboxPidsLimit = parseOptionalPositiveIntegerEnv("SANDBOX_PIDS_LIMIT");
const sandboxTimeoutMs = parseOptionalPositiveIntegerEnv("SANDBOX_TIMEOUT_MS");
const queueDriver = parseQueueDriver(process.env.QUEUE_DRIVER);
const redisUrl = process.env.REDIS_URL;
const storeDriver = parseStoreDriver(process.env.STORE_DRIVER);
const databaseUrl = process.env.DATABASE_URL;
const jobConcurrency = parsePositiveIntegerEnv("JOB_CONCURRENCY", 2);
const jobMaxAttempts = parsePositiveIntegerEnv("JOB_MAX_ATTEMPTS", 3);
const maxSteps = parsePositiveIntegerEnv("AGENT_MAX_STEPS", 8);
const defaultSourcePath = resolve(process.env.DEFAULT_SOURCE_PATH ?? process.cwd());
const allowedSourceRoot = resolve(process.env.SANDBOX_SOURCE_ROOT ?? defaultSourcePath);

const app = await buildApp({
  sandboxRoot,
  sandboxDriver,
  sandboxImage,
  sandboxCpus,
  sandboxMemory,
  sandboxNetwork,
  sandboxUser,
  sandboxPidsLimit,
  sandboxTimeoutMs,
  queueDriver,
  redisUrl,
  storeDriver,
  databaseUrl,
  jobConcurrency,
  jobMaxAttempts,
  maxSteps,
  defaultSourcePath,
  allowedSourceRoot
});

await app.listen({ host: "127.0.0.1", port });

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
