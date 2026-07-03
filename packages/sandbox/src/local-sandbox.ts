import { spawn } from "node:child_process";
import type { SandboxCommand, SandboxResult } from "../../agent-core/src/types.js";
import { OutputBuffer } from "./output-buffer.js";
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

      const stdout = new OutputBuffer();
      const stderr = new OutputBuffer();
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout.append(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.append(chunk);
      });

      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolvePromise({
          stdout: stdout.toString(),
          stderr: (timedOut ? `Command timed out after ${timeoutMs}ms\n` : "") + stderr.toString(),
          exitCode,
          durationMs: Date.now() - started
        });
      });
    });
  }
}
