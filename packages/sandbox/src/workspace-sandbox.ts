import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { Sandbox, SandboxCommand, SandboxResult } from "../../agent-core/src/types.js";

export interface WorkspaceSandboxOptions {
  rootDir: string;
}

export abstract class WorkspaceSandbox implements Sandbox {
  constructor(protected readonly workspaceOptions: WorkspaceSandboxOptions) {}

  async prepare(jobId: string): Promise<string> {
    const workspacePath = this.workspaceFor(jobId);
    await mkdir(workspacePath, { recursive: true });
    return workspacePath;
  }

  abstract exec(jobId: string, command: SandboxCommand): Promise<SandboxResult>;

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

  protected workspaceFor(jobId: string): string {
    return resolve(this.workspaceOptions.rootDir, jobId);
  }

  protected safePath(jobId: string, relativePath: string): string {
    const workspacePath = this.workspaceFor(jobId);
    const filePath = resolve(workspacePath, relativePath);
    const rel = relative(workspacePath, filePath);
    if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
      throw new Error("Sandbox path escape blocked");
    }
    return filePath;
  }
}
