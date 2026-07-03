import { resolve } from "node:path";
import { loadEnvFile } from "./env.js";

loadEnvFile();

const { buildApp } = await import("./app.js");

const port = Number(process.env.PORT ?? 8080);
const sandboxRoot = resolve(process.env.SANDBOX_ROOT ?? "./workspace-runs");
const sandboxDriver = process.env.SANDBOX_DRIVER === "docker" ? "docker" : "local";
const sandboxImage = process.env.SANDBOX_IMAGE ?? "cloud-agent-sandbox:latest";
const sandboxCpus = process.env.SANDBOX_CPUS;
const sandboxMemory = process.env.SANDBOX_MEMORY;
const sandboxNetwork = parseSandboxNetwork(process.env.SANDBOX_NETWORK);
const sandboxTimeoutMs = process.env.SANDBOX_TIMEOUT_MS ? Number(process.env.SANDBOX_TIMEOUT_MS) : undefined;
const maxSteps = Number(process.env.AGENT_MAX_STEPS ?? 8);
const defaultSourcePath = resolve(process.env.DEFAULT_SOURCE_PATH ?? process.cwd());

const app = await buildApp({
  sandboxRoot,
  sandboxDriver,
  sandboxImage,
  sandboxCpus,
  sandboxMemory,
  sandboxNetwork,
  sandboxTimeoutMs,
  maxSteps,
  defaultSourcePath
});

await app.listen({ host: "127.0.0.1", port });

function parseSandboxNetwork(value: string | undefined): "none" | "bridge" | "host" | undefined {
  if (value === "none" || value === "bridge" || value === "host") {
    return value;
  }
  return undefined;
}
