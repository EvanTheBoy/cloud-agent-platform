import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Sandbox, SandboxCommand, SandboxResult } from "../../agent-core/src/types.js";
import { WorkspaceSandbox, type WorkspaceSandboxOptions } from "./workspace-sandbox.js";

export interface DockerSandboxOptions extends WorkspaceSandboxOptions {
  image: string;
  dockerPath?: string;
  cpus?: string;
  memory?: string;
  network?: "none" | "bridge" | "host";
  defaultTimeoutMs?: number;
}

export class DockerSandbox extends WorkspaceSandbox implements Sandbox {
  constructor(private readonly options: DockerSandboxOptions) {
    super(options);
  }

  async exec(jobId: string, command: SandboxCommand): Promise<SandboxResult> {
    const started = Date.now();
    const workspacePath = await this.prepare(jobId);
    const timeoutMs = command.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000;
    const containerName = this.containerName(jobId);
    const dockerPath = this.options.dockerPath ?? "docker";
    const dockerArgs = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--network",
      this.options.network ?? "none",
      "--workdir",
      "/workspace",
      "--volume",
      `${workspacePath}:/workspace:rw`,
      "--env",
      "HOME=/workspace",
      ...(this.options.cpus ? ["--cpus", this.options.cpus] : []),
      ...(this.options.memory ? ["--memory", this.options.memory] : []),
      this.options.image,
      command.command,
      ...(command.args ?? [])
    ];

    return await new Promise<SandboxResult>((resolvePromise) => {
      const child = spawn(dockerPath, dockerArgs, {
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const finish = (result: SandboxResult) => {
        if (settled) {
          return;
        }
        settled = true;
        resolvePromise(result);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        this.forceRemoveContainer(dockerPath, containerName);
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        finish({
          stdout: stdout.slice(0, 20_000),
          stderr: `${timedOut ? `Command timed out after ${timeoutMs}ms\n` : ""}${error.message}\n${stderr}`.slice(0, 20_000),
          exitCode: null,
          durationMs: Date.now() - started
        });
      });

      child.on("close", (exitCode) => {
        clearTimeout(timer);
        finish({
          stdout: stdout.slice(0, 20_000),
          stderr: (timedOut ? `Command timed out after ${timeoutMs}ms\n` : "") + stderr.slice(0, 20_000),
          exitCode,
          durationMs: Date.now() - started
        });
      });
    });
  }

  private containerName(jobId: string): string {
    const safeJobId = jobId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
    return `cap-${safeJobId}-${randomUUID().slice(0, 8)}`;
  }

  private forceRemoveContainer(dockerPath: string, containerName: string): void {
    const cleanup = spawn(dockerPath, ["rm", "-f", containerName], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    cleanup.on("error", () => {});
  }
}
