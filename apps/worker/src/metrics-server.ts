import { createServer } from "node:http";
import type { Server } from "node:http";
import type { MetricsRecorder } from "../../../packages/agent-core/src/index.js";

export interface WorkerMetricsServerOptions {
  host: string;
  port: number;
}

export interface WorkerMetricsResponse {
  status: number;
  contentType: string;
  body: string;
}

export function renderWorkerMetricsResponse(
  metrics: MetricsRecorder,
  method: string | undefined,
  requestUrl: string | undefined
): WorkerMetricsResponse {
  const url = new URL(requestUrl ?? "/", "http://localhost");

  if (method === "GET" && url.pathname === "/metrics") {
    return {
      status: 200,
      contentType: "text/plain; version=0.0.4; charset=utf-8",
      body: metrics.renderPrometheus?.() ?? ""
    };
  }

  if (method === "GET" && url.pathname === "/health") {
    return {
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ ok: true })
    };
  }

  return {
    status: 404,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ error: "not_found" })
  };
}

export async function startWorkerMetricsServer(
  metrics: MetricsRecorder,
  options: WorkerMetricsServerOptions
): Promise<Server> {
  const server = createServer((request, response) => {
    const rendered = renderWorkerMetricsResponse(metrics, request.method, request.url);
    response.writeHead(rendered.status, { "content-type": rendered.contentType });
    response.end(rendered.body);
  });

  return await new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
}

export async function closeWorkerMetricsServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
