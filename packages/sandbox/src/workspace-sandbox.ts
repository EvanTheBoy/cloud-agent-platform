import { cp, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
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
    const filePath = await this.safeWritePath(jobId, relativePath);
    await writeFile(filePath, content, "utf8");
  }

  async readFile(jobId: string, relativePath: string): Promise<string> {
    return await readFile(await this.safeReadPath(jobId, relativePath), "utf8");
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
        filter: async (source) => {
          if (ignored.has(basename(source))) {
            return false;
          }
          const stat = await lstat(source);
          return stat.isDirectory() || stat.isFile();
        }
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
    if (rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error("Sandbox path escape blocked");
    }
    return filePath;
  }

  private async safeReadPath(jobId: string, relativePath: string): Promise<string> {
    const filePath = this.safePath(jobId, relativePath);
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error("Sandbox symlink read blocked");
    }
    const realFilePath = await realpath(filePath);
    await this.assertInsideWorkspace(jobId, realFilePath);
    return realFilePath;
  }

  private async safeWritePath(jobId: string, relativePath: string): Promise<string> {
    const filePath = this.safePath(jobId, relativePath);
    const parentPath = resolve(filePath, "..");
    await mkdir(parentPath, { recursive: true });

    const realParentPath = await realpath(parentPath);
    await this.assertInsideWorkspace(jobId, realParentPath);

    try {
      const stat = await lstat(filePath);
      if (stat.isSymbolicLink()) {
        throw new Error("Sandbox symlink write blocked");
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    return filePath;
  }

  private async assertInsideWorkspace(jobId: string, targetPath: string): Promise<void> {
    const realWorkspacePath = await realpath(this.workspaceFor(jobId));
    const rel = relative(realWorkspacePath, targetPath);
    if (rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error("Sandbox path escape blocked");
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
