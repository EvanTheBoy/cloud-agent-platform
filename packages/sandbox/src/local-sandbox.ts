import { spawn } from "node:child_process";
import type { SandboxCommand, SandboxResult } from "../../agent-core/src/types.js";
import { WorkspaceSandbox, type WorkspaceSandboxOptions } from "./workspace-sandbox.js";

export interface LocalSandboxOptions extends WorkspaceSandboxOptions {}

export class LocalSandbox extends WorkspaceSandbox {
  constructor(options: LocalSandboxOptions) {
    super(options);
  }

  async exec(jobId: string, command: SandboxCommand): Promise<SandboxResult> {
    const started = Date.now();
    const workspacePath = await this.prepare(jobId);
    const timeoutMs = command.timeoutMs ?? 30_000;

    return await new Promise<SandboxResult>((resolvePromise) => {
      const child = spawn(command.command, command.args ?? [], {
        cwd: workspacePath,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: workspacePath
        },
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolvePromise({
          stdout: stdout.slice(0, 20_000),
          stderr: (timedOut ? `Command timed out after ${timeoutMs}ms\n` : "") + stderr.slice(0, 20_000),
          exitCode,
          durationMs: Date.now() - started
        });
      });
    });
  }
}
