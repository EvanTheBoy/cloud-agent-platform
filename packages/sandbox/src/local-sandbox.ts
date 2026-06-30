import { spawn } from "node:child_process";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve, relative, sep } from "node:path";
import type { Sandbox, SandboxCommand, SandboxResult } from "../../agent-core/src/types.js";

export interface LocalSandboxOptions {
  rootDir: string;
}

export class LocalSandbox implements Sandbox {
  constructor(private readonly options: LocalSandboxOptions) {}

  async prepare(jobId: string): Promise<string> {
    const workspacePath = this.workspaceFor(jobId);
    await mkdir(workspacePath, { recursive: true });
    return workspacePath;
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

  async writeFile(jobId: string, relativePath: string, content: string): Promise<void> {
    const filePath = this.safePath(jobId, relativePath);
    await mkdir(resolve(filePath, ".."), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }

  async readFile(jobId: string, relativePath: string): Promise<string> {
    return await readFile(this.safePath(jobId, relativePath), "utf8");
  }

  async importDirectory(jobId: string, sourcePath: string): Promise<void> {
    const workspacePath = await this.prepare(jobId);
    const sourceRoot = resolve(sourcePath);
    const ignored = new Set(["node_modules", "dist", ".git", "workspace-runs"]);
    const entries = await readdir(sourceRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (ignored.has(entry.name)) {
        continue;
      }
      const from = resolve(sourceRoot, entry.name);
      const to = resolve(workspacePath, entry.name);
      await cp(from, to, {
        recursive: true,
        force: true,
        filter: (source) => !ignored.has(basename(source))
      });
    }
  }

  private workspaceFor(jobId: string): string {
    return resolve(this.options.rootDir, jobId);
  }

  private safePath(jobId: string, relativePath: string): string {
    const workspacePath = this.workspaceFor(jobId);
    const filePath = resolve(workspacePath, relativePath);
    const rel = relative(workspacePath, filePath);
    if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
      throw new Error("Sandbox path escape blocked");
    }
    return filePath;
  }
}
