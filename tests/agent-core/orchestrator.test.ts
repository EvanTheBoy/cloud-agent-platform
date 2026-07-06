import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentOrchestrator, InMemoryJobStore, OpenAiCompatibleProvider, shellExecTool } from "../../packages/agent-core/src/index.js";
import type { LlmProvider, LlmResponse, Sandbox, SandboxCommand, SandboxResult, Tool } from "../../packages/agent-core/src/types.js";

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

  it("persists LLM diagnostics when OpenAI-compatible tool arguments are malformed", async () => {
    const originalFetch = globalThis.fetch;
    const apiKey = "sk-test-secret";
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call-1",
                    function: {
                      name: "shell_exec",
                      arguments: "{\"command\" \"sh\"}"
                    }
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );

    try {
      const store = new InMemoryJobStore();
      const job = await store.create({
        id: "job-llm-parse",
        task: "inspect files",
        workspacePath: "/workspace/job-llm-parse"
      });
      const llm = new OpenAiCompatibleProvider({
        apiKey,
        baseUrl: "https://api.example.test/v1?token=do-not-log",
        model: "qwen-plus"
      });
      const orchestrator = new AgentOrchestrator({
        store,
        sandbox: new MatchingWorkspaceSandbox(),
        llm,
        tools: [shellExecTool]
      });

      const result = await orchestrator.run(job.id);
      const events = await store.getEvents(job.id);
      const eventTypes = events.map((event) => event.type);
      const parseEvent = events.find((event) => event.type === "llm.tool_arguments_parse_failed");
      const payloadText = JSON.stringify(events);

      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /expected ':' after property name/i);
      assert.deepEqual(
        eventTypes.filter((type) => type.startsWith("llm.")),
        ["llm.request.started", "llm.response.received", "llm.tool_arguments_parse_failed"]
      );
      assert.equal(parseEvent?.payload.provider, "openai-compatible");
      assert.equal(parseEvent?.payload.model, "qwen-plus");
      assert.equal(parseEvent?.payload.baseUrlHost, "api.example.test");
      assert.equal(parseEvent?.payload.toolName, "shell.exec");
      assert.equal(parseEvent?.payload.rawArgumentsPreview, "{\"command\" \"sh\"}");
      assert.equal(parseEvent?.payload.rawArgumentsLength, 16);
      assert.match(String(parseEvent?.payload.parseError), /expected ':' after property name/i);
      assert.equal(payloadText.includes(apiKey), false);
      assert.equal(payloadText.includes("do-not-log"), false);
      assert.equal(payloadText.includes("Bearer"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("persists tool and sandbox diagnostics around shell execution", async () => {
    const store = new InMemoryJobStore();
    const job = await store.create({
      id: "job-tool-success",
      task: "inspect files",
      workspacePath: "/workspace/job-tool-success"
    });
    const orchestrator = new AgentOrchestrator({
      store,
      sandbox: new SuccessfulCommandSandbox(),
      llm: new StaticLlmProvider({
        message: "I will inspect the workspace.",
        toolCalls: [
          {
            id: "call-1",
            name: "shell.exec",
            input: {
              command: "sh",
              args: ["-lc", "echo ok"],
              timeoutMs: 1000
            }
          }
        ]
      }),
      tools: [shellExecTool],
      maxSteps: 1
    });

    const result = await orchestrator.run(job.id);
    const events = await store.getEvents(job.id);
    const eventTypes = events.map((event) => event.type);
    const toolStarted = events.find((event) => event.type === "tool.started");
    const toolFinished = events.find((event) => event.type === "tool.finished");
    const sandboxFinished = events.find((event) => event.type === "sandbox.command.finished");

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /maxSteps=1/);
    assert.deepEqual(
      eventTypes.filter((type) => type.startsWith("tool.") || type.startsWith("sandbox.")),
      ["tool.started", "sandbox.command.started", "sandbox.command.finished", "tool.finished"]
    );
    assert.deepEqual(toolStarted?.payload.inputPreview, {
      command: "sh",
      argsCount: 2,
      timeoutMs: 1000
    });
    assert.equal(toolFinished?.payload.toolName, "shell.exec");
    assert.equal(toolFinished?.payload.final, false);
    assert.equal(sandboxFinished?.payload.command, "sh");
    assert.equal(sandboxFinished?.payload.argsCount, 2);
    assert.equal(sandboxFinished?.payload.exitCode, 0);
    assert.equal(sandboxFinished?.payload.stdoutBytes, 3);
    assert.equal(sandboxFinished?.payload.stderrBytes, 0);
    assert.equal(sandboxFinished?.payload.stdoutTruncated, false);
  });

  it("persists tool failure diagnostics when a tool throws", async () => {
    const store = new InMemoryJobStore();
    const job = await store.create({
      id: "job-tool-failure",
      task: "run failing tool",
      workspacePath: "/workspace/job-tool-failure"
    });
    const failingTool: Tool = {
      name: "test.fail",
      description: "Throw an error for diagnostics testing.",
      async execute() {
        throw new Error("tool exploded");
      }
    };
    const orchestrator = new AgentOrchestrator({
      store,
      sandbox: new SuccessfulCommandSandbox(),
      llm: new StaticLlmProvider({
        message: "I will run the failing tool.",
        toolCalls: [{ id: "call-1", name: failingTool.name, input: { token: "secret-token", ok: true } }]
      }),
      tools: [failingTool]
    });

    const result = await orchestrator.run(job.id);
    const events = await store.getEvents(job.id);
    const toolStarted = events.find((event) => event.type === "tool.started");
    const toolFailed = events.find((event) => event.type === "tool.failed");

    assert.equal(result.status, "failed");
    assert.equal(result.error, "tool exploded");
    assert.deepEqual(toolStarted?.payload.inputPreview, { token: "[redacted]", ok: true });
    assert.equal(toolFailed?.payload.toolName, failingTool.name);
    assert.equal(toolFailed?.payload.error, "tool exploded");
    assert.equal(JSON.stringify(toolStarted).includes("secret-token"), false);
  });

  it("persists sandbox failure diagnostics when command execution throws", async () => {
    const store = new InMemoryJobStore();
    const job = await store.create({
      id: "job-sandbox-failure",
      task: "run sandbox command",
      workspacePath: "/workspace/job-sandbox-failure"
    });
    const orchestrator = new AgentOrchestrator({
      store,
      sandbox: new ThrowingCommandSandbox(),
      llm: new StaticLlmProvider({
        message: "I will run a command.",
        toolCalls: [
          {
            id: "call-1",
            name: "shell.exec",
            input: { command: "sh", args: ["-lc", "exit 1"], timeoutMs: 2000 }
          }
        ]
      }),
      tools: [shellExecTool]
    });

    const result = await orchestrator.run(job.id);
    const events = await store.getEvents(job.id);
    const eventTypes = events.map((event) => event.type);
    const sandboxFailed = events.find((event) => event.type === "sandbox.command.failed");
    const toolFailed = events.find((event) => event.type === "tool.failed");

    assert.equal(result.status, "failed");
    assert.equal(result.error, "sandbox unavailable");
    assert.deepEqual(
      eventTypes.filter((type) => type.startsWith("tool.") || type.startsWith("sandbox.")),
      ["tool.started", "sandbox.command.started", "sandbox.command.failed", "tool.failed"]
    );
    assert.equal(sandboxFailed?.payload.command, "sh");
    assert.equal(sandboxFailed?.payload.argsCount, 2);
    assert.equal(sandboxFailed?.payload.timeoutMs, 2000);
    assert.equal(sandboxFailed?.payload.error, "sandbox unavailable");
    assert.equal(toolFailed?.payload.error, "sandbox unavailable");
  });
});

class MatchingWorkspaceSandbox implements Sandbox {
  async prepare(): Promise<string> {
    return "/workspace/job-llm-parse";
  }

  async validateWorkspace(): Promise<void> {}

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

class StaticLlmProvider implements LlmProvider {
  constructor(private readonly response: LlmResponse) {}

  async complete(): Promise<LlmResponse> {
    return this.response;
  }
}

class SuccessfulCommandSandbox implements Sandbox {
  async prepare(): Promise<string> {
    return "/workspace/job-tool-success";
  }

  async validateWorkspace(): Promise<void> {}

  async exec(_jobId: string, _command: SandboxCommand): Promise<SandboxResult> {
    return {
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
      durationMs: 12
    };
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

class ThrowingCommandSandbox extends SuccessfulCommandSandbox {
  async exec(): Promise<SandboxResult> {
    throw new Error("sandbox unavailable");
  }
}
