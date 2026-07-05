import type { ConnectionOptions } from "bullmq";

export function parseRedisConnection(redisUrl: string): ConnectionOptions {
  let url: URL;
  try {
    url = new URL(redisUrl);
  } catch {
    throw new Error("Invalid REDIS_URL");
  }

  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error(`Invalid REDIS_URL protocol: ${url.protocol}`);
  }

  const host = normalizeRedisHost(url.hostname);
  if (!host) {
    throw new Error("Invalid REDIS_URL host");
  }

  const port = url.port ? Number(url.port) : 6379;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid Redis port in REDIS_URL: ${url.port}`);
  }

  const db = url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined;
  if (db !== undefined && (!Number.isInteger(db) || db < 0)) {
    throw new Error(`Invalid Redis database in REDIS_URL: ${url.pathname}`);
  }

  return {
    host,
    port,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db,
    maxRetriesPerRequest: null,
    ...(url.protocol === "rediss:" ? { tls: {} } : {})
  };
}

function normalizeRedisHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
