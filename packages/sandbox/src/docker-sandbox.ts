import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Sandbox, SandboxCommand, SandboxResult } from "../../agent-core/src/types.js";
import { OutputBuffer } from "./output-buffer.js";
import { WorkspaceSandbox, type WorkspaceSandboxOptions } from "./workspace-sandbox.js";

export interface DockerSandboxOptions extends WorkspaceSandboxOptions {
  image: string;
  dockerPath?: string;
  cpus?: string;
  memory?: string;
  network?: "none" | "bridge" | "host";
  user?: string;
  pidsLimit?: number;
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
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(this.options.pidsLimit ?? 256),
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--network",
      this.options.network ?? "none",
      "--workdir",
      "/workspace",
      "--volume",
      `${workspacePath}:/workspace:rw`,
      "--env",
      "HOME=/workspace",
      "--user",
      this.options.user ?? defaultDockerUser(),
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

      const stdout = new OutputBuffer();
      const stderr = new OutputBuffer();
      let timedOut = false;
      let settled = false;
      let cleanupPromise: Promise<void> | undefined;

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
        cleanupPromise = this.forceRemoveContainer(dockerPath, containerName);
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout.append(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.append(chunk);
      });

      child.on("error", async (error) => {
        clearTimeout(timer);
        await cleanupPromise;
        finish({
          stdout: stdout.toString(),
          stderr: `${timedOut ? `Command timed out after ${timeoutMs}ms\n` : ""}${error.message}\n${stderr.toString()}`,
          exitCode: null,
          durationMs: Date.now() - started
        });
      });

      child.on("close", async (exitCode) => {
        clearTimeout(timer);
        await cleanupPromise;
        finish({
          stdout: stdout.toString(),
          stderr: (timedOut ? `Command timed out after ${timeoutMs}ms\n` : "") + stderr.toString(),
          exitCode,
          durationMs: Date.now() - started
        });
      });
    });
  }

  private containerName(jobId: string): string {
    const safeJobId = jobId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
    return `cap-${safeJobId}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }

  private async forceRemoveContainer(dockerPath: string, containerName: string): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        cleanup.kill("SIGKILL");
        cleanup.unref();
        resolvePromise();
      }, 5_000);
      const cleanup = spawn(dockerPath, ["rm", "-f", containerName], {
        stdio: ["ignore", "ignore", "ignore"]
      });
      cleanup.on("error", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      cleanup.on("close", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }
}

function defaultDockerUser(): string {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid !== undefined && gid !== undefined ? `${uid}:${gid}` : "node";
}
