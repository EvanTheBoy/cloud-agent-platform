import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentOrchestrator, InMemoryJobStore } from "../../packages/agent-core/src/index.js";
import type { LlmProvider, Sandbox, SandboxCommand, SandboxResult } from "../../packages/agent-core/src/types.js";

describe("AgentOrchestrator", () => {
  it("fails the job before running tools when the worker workspace does not match the stored path", async () => {
    const store = new InMemoryJobStore();
    const job = await store.create({
      id: "job-1",
      task: "inspect files",
      workspacePath: "/api/workspace-runs/job-1"
    });
    const sandbox = new MismatchedWorkspaceSandbox();
    const llm = new ThrowingLlmProvider();
    const orchestrator = new AgentOrchestrator({
      store,
      sandbox,
      llm,
      tools: []
    });

    const result = await orchestrator.run(job.id);
    const events = await store.getEvents(job.id);

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /workspace path mismatch/i);
    assert.equal(events.at(-1)?.type, "job.finished");
    assert.equal(events.at(-1)?.payload.status, "failed");
  });
});

class MismatchedWorkspaceSandbox implements Sandbox {
  async prepare(): Promise<string> {
    return "/worker/workspace-runs/job-1";
  }

  async validateWorkspace(): Promise<void> {
    throw new Error(
      "Sandbox workspace path mismatch for job job-1: expected /api/workspace-runs/job-1, configured /worker/workspace-runs/job-1"
    );
  }

  async exec(_jobId: string, _command: SandboxCommand): Promise<SandboxResult> {
    throw new Error("exec should not be called");
  }

  async writeFile(): Promise<void> {
    throw new Error("writeFile should not be called");
  }

  async readFile(): Promise<string> {
    throw new Error("readFile should not be called");
  }

  async importDirectory(): Promise<void> {
    throw new Error("importDirectory should not be called");
  }
}

class ThrowingLlmProvider implements LlmProvider {
  async complete(): Promise<never> {
    throw new Error("LLM should not be called");
  }
}
