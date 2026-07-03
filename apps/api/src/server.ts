import { resolve } from "node:path";
import { loadEnvFile } from "./env.js";

loadEnvFile();

const { buildApp } = await import("./app.js");

const port = Number(process.env.PORT ?? 8080);
const sandboxRoot = resolve(process.env.SANDBOX_ROOT ?? "./workspace-runs");
const maxSteps = Number(process.env.AGENT_MAX_STEPS ?? 8);
const defaultSourcePath = resolve(process.env.DEFAULT_SOURCE_PATH ?? process.cwd());

const app = await buildApp({ sandboxRoot, maxSteps, defaultSourcePath });

await app.listen({ host: "127.0.0.1", port });
