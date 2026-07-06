import { loadServerConfig } from "./config.js";
import { loadEnvFile } from "./env.js";

loadEnvFile();

const { buildApp } = await import("./app.js");

const config = loadServerConfig();

const app = await buildApp({
  ...config,
  processJobsInApi: config.queueDriver === "memory"
});

await app.listen({ host: "127.0.0.1", port: config.port });
