import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentOrchestrator, InMemoryJobStore, InMemoryMetricsRecorder, OpenAiCompatibleProvider, shellExecTool } from "../../packages/agent-core/src/index.js";
import type { JobEvent, JobEventType, LlmProvider, LlmResponse, Sandbox, SandboxCommand, SandboxResult, Tool } from "../../packages/agent-core/src/types.js";

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
      assert.equal(parseEvent?.payload.reason, "invalid_json");
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
    const metrics = new InMemoryMetricsRecorder();
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
      maxSteps: 1,
      metrics
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
      requestedTimeoutMs: 1000
    });
    assert.equal(toolFinished?.payload.toolName, "shell.exec");
    assert.equal(toolFinished?.payload.final, false);
    assert.equal(sandboxFinished?.payload.command, "sh");
    assert.equal(sandboxFinished?.payload.argsCount, 2);
    assert.equal(sandboxFinished?.payload.exitCode, 0);
    assert.equal(sandboxFinished?.payload.stdoutBytes, 3);
    assert.equal(sandboxFinished?.payload.stderrBytes, 0);
    assert.equal(sandboxFinished?.payload.stdoutTruncated, false);
    assert.match(metrics.renderPrometheus(), /agent_tool_duration_ms_count\{outcome="success",toolName="shell\.exec"\} 1/);
    assert.match(metrics.renderPrometheus(), /agent_sandbox_command_duration_ms_count\{outcome="success"\} 1/);
    assert.match(metrics.renderPrometheus(), /agent_jobs_total\{status="failed"\} 1/);
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

  it("redacts task text in job.created events", async () => {
    const store = new InMemoryJobStore();
    const job = await store.create({
      id: "job-created-redaction",
      task:
        "Fetch https://example.test/path?token=secret-task-token with Authorization: Bearer secret-task-bearer and Cookie: session=secret-task-cookie",
      workspacePath: "/workspace/job-created-redaction"
    });
    const events = await store.getEvents(job.id);
    const jobCreated = events.find((event) => event.type === "job.created");
    const payloadText = JSON.stringify(jobCreated);

    assert.equal(job.task.includes("secret-task-token"), true);
    assert.equal(payloadText.includes("secret-task-token"), false);
    assert.equal(payloadText.includes("secret-task-bearer"), false);
    assert.equal(payloadText.includes("secret-task-cookie"), false);
    assert.equal(payloadText.includes("\"task\""), false);
    assert.equal(payloadText.includes("taskPreview"), true);
    assert.equal(payloadText.includes("taskBytes"), true);
    assert.equal(payloadText.includes("[url redacted]"), true);
    assert.equal(payloadText.includes("[redacted]"), true);
  });

  it("preserves raw failure state while redacting errors in job events", async () => {
    const store = new InMemoryJobStore();
    const job = await store.create({
      id: "job-error-redaction",
      task: "run failing tool",
      workspacePath: "/workspace/job-error-redaction"
    });
    const rawError =
      "Failed URL https://example.test/path?token=secret-error-token\nAuthorization: Bearer secret-error-bearer\nCookie: session=secret-error-cookie";
    const failingTool: Tool = {
      name: "test.secret-fail",
      description: "Throw an error containing sensitive values.",
      async execute() {
        throw new Error(rawError);
      }
    };
    const orchestrator = new AgentOrchestrator({
      store,
      sandbox: new SuccessfulCommandSandbox(),
      llm: new StaticLlmProvider({
        message: "I will run the failing tool.",
        toolCalls: [{ id: "call-1", name: failingTool.name, input: {} }]
      }),
      tools: [failingTool]
    });

    const result = await orchestrator.run(job.id);
    const persistedJob = await store.get(job.id);
    const events = await store.getEvents(job.id);
    const jobFinished = events.find((event) => event.type === "job.finished");
    const jobUpdatedEvents = events.filter((event) => event.type === "job.updated");
    const persistedText = JSON.stringify({
      jobFinished,
      jobUpdatedEvents
    });

    assert.equal(result.status, "failed");
    assert.equal(result.error?.includes("secret-error-token"), true);
    assert.equal(persistedJob?.error?.includes("secret-error-bearer"), true);
    assert.equal(persistedText.includes("secret-error-token"), false);
    assert.equal(persistedText.includes("secret-error-bearer"), false);
    assert.equal(persistedText.includes("secret-error-cookie"), false);
    assert.equal(jobFinished?.payload.error, undefined);
    assert.equal(jobUpdatedEvents.some((event) => "error" in (event.payload.job as Record<string, unknown>)), false);
    assert.equal(persistedText.includes("errorPreview"), true);
    assert.equal(persistedText.includes("errorBytes"), true);
    assert.equal(persistedText.includes("[url redacted]"), true);
    assert.equal(persistedText.includes("[redacted]"), true);
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
    assert.equal(sandboxFailed?.payload.requestedTimeoutMs, 2000);
    assert.equal(sandboxFailed?.payload.error, "sandbox unavailable");
    assert.equal(toolFailed?.payload.error, "sandbox unavailable");
  });

  it("does not let diagnostic event failures block tool execution", async () => {
    await withSilencedConsoleWarn(async () => {
      const store = new FailingDiagnosticEventStore(["tool.started", "tool.finished", "sandbox.command.started"]);
      const job = await store.create({
        id: "job-diagnostic-write-failure",
        task: "inspect files",
        workspacePath: "/workspace/job-diagnostic-write-failure"
      });
      const orchestrator = new AgentOrchestrator({
        store,
        sandbox: new SuccessfulCommandSandbox(),
        llm: new StaticLlmProvider({
          message: "I will inspect the workspace.",
          toolCalls: [{ id: "call-1", name: "shell.exec", input: { command: "sh" } }]
        }),
        tools: [shellExecTool],
        maxSteps: 1
      });

      const result = await orchestrator.run(job.id);
      const events = await store.getEvents(job.id);

      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /maxSteps=1/);
      assert.equal(events.some((event) => event.type === "step.finished"), true);
      assert.equal(events.some((event) => event.type === "tool.failed"), false);
    });
  });

  it("does not turn sandbox success into failure when sandbox finished diagnostics fail", async () => {
    await withSilencedConsoleWarn(async () => {
      const store = new FailingDiagnosticEventStore(["sandbox.command.finished"]);
      const job = await store.create({
        id: "job-sandbox-finished-diagnostic-failure",
        task: "inspect files",
        workspacePath: "/workspace/job-sandbox-finished-diagnostic-failure"
      });
      const orchestrator = new AgentOrchestrator({
        store,
        sandbox: new SuccessfulCommandSandbox(),
        llm: new StaticLlmProvider({
          message: "I will inspect the workspace.",
          toolCalls: [{ id: "call-1", name: "shell.exec", input: { command: "sh" } }]
        }),
        tools: [shellExecTool],
        maxSteps: 1
      });

      const result = await orchestrator.run(job.id);
      const events = await store.getEvents(job.id);

      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /maxSteps=1/);
      assert.equal(events.some((event) => event.type === "tool.finished"), true);
      assert.equal(events.some((event) => event.type === "sandbox.command.failed"), false);
      assert.equal(events.some((event) => event.type === "tool.failed"), false);
    });
  });

  it("redacts sensitive values in generic tool input diagnostics", async () => {
    const store = new InMemoryJobStore();
    const job = await store.create({
      id: "job-tool-redaction",
      task: "run custom tool",
      workspacePath: "/workspace/job-tool-redaction"
    });
    const customTool: Tool = {
      name: "test.custom",
      description: "Return a small observation.",
      async execute() {
        return { observation: "done" };
      }
    };
    const orchestrator = new AgentOrchestrator({
      store,
      sandbox: new SuccessfulCommandSandbox(),
      llm: new StaticLlmProvider({
        message: "I will run a custom tool.",
        toolCalls: [
          {
            id: "call-1",
            name: customTool.name,
            input: {
              url: "https://example.test/path?token=secret-token&ok=1",
              header: "Authorization: Bearer secret-bearer",
              cookieHeader: "Cookie: session=secret-cookie",
              nested: { endpoint: "https://example.test/path?api_key=secret-key" }
            }
          }
        ]
      }),
      tools: [customTool],
      maxSteps: 1
    });

    await orchestrator.run(job.id);
    const events = await store.getEvents(job.id);
    const toolStarted = events.find((event) => event.type === "tool.started");
    const payloadText = JSON.stringify(toolStarted);

    assert.equal(payloadText.includes("secret-token"), false);
    assert.equal(payloadText.includes("secret-bearer"), false);
    assert.equal(payloadText.includes("secret-cookie"), false);
    assert.equal(payloadText.includes("secret-key"), false);
    assert.equal(payloadText.includes("[redacted]"), true);
  });

  it("redacts malformed LLM tool arguments before persisting previews", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "call-1",
                    function: {
                      name: "shell_exec",
                      arguments:
                        "{\"url\":\"https://example.test/path?token=secret-token\", \"header\":\"Authorization: Bearer secret-bearer\", \"token\":\"secret-json-token\""
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
        id: "job-llm-redaction",
        task: "inspect files",
        workspacePath: "/workspace/job-llm-redaction"
      });
      const orchestrator = new AgentOrchestrator({
        store,
        sandbox: new MatchingWorkspaceSandbox(),
        llm: new OpenAiCompatibleProvider({ apiKey: "sk-test-secret", baseUrl: "https://api.example.test/v1" }),
        tools: [shellExecTool]
      });

      await orchestrator.run(job.id);
      const events = await store.getEvents(job.id);
      const parseEvent = events.find((event) => event.type === "llm.tool_arguments_parse_failed");
      const payloadText = JSON.stringify(parseEvent);

      assert.equal(payloadText.includes("secret-token"), false);
      assert.equal(payloadText.includes("secret-bearer"), false);
      assert.equal(payloadText.includes("secret-json-token"), false);
      assert.equal(payloadText.includes("[url redacted]"), true);
      assert.equal(payloadText.includes("[redacted]"), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("persists LLM diagnostics when tool arguments parse to a non-object value", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "call-1",
                    function: {
                      name: "shell_exec",
                      arguments: "[]"
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
        id: "job-llm-non-object",
        task: "inspect files",
        workspacePath: "/workspace/job-llm-non-object"
      });
      const orchestrator = new AgentOrchestrator({
        store,
        sandbox: new MatchingWorkspaceSandbox(),
        llm: new OpenAiCompatibleProvider({ apiKey: "sk-test-secret", baseUrl: "https://api.example.test/v1" }),
        tools: [shellExecTool]
      });

      const result = await orchestrator.run(job.id);
      const events = await store.getEvents(job.id);
      const parseEvent = events.find((event) => event.type === "llm.tool_arguments_parse_failed");

      assert.equal(result.status, "failed");
      assert.equal(result.error, "Tool arguments must be a JSON object.");
      assert.equal(parseEvent?.payload.reason, "not_object");
      assert.equal(parseEvent?.payload.rawArgumentsPreview, "[]");
      assert.equal(parseEvent?.payload.parseError, "Tool arguments must be a JSON object.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("redacts persisted step events and job step state", async () => {
    const store = new InMemoryJobStore();
    const job = await store.create({
      id: "job-step-redaction",
      task: "run shell command",
      workspacePath: "/workspace/job-step-redaction"
    });
    const orchestrator = new AgentOrchestrator({
      store,
      sandbox: new SecretOutputSandbox(),
      llm: new StaticLlmProvider({
        message: "I will run a shell command.",
        toolCalls: [
          {
            id: "call-1",
            name: "shell.exec",
            input: {
              command: "sh",
              args: ["-lc", "curl https://example.test/path?token=secret-token -H 'Authorization: Bearer secret-bearer'"]
            }
          }
        ]
      }),
      tools: [shellExecTool],
      maxSteps: 1
    });

    await orchestrator.run(job.id);
    const persistedJob = await store.get(job.id);
    const events = await store.getEvents(job.id);
    const stepStarted = events.find((event) => event.type === "step.started");
    const stepFinished = events.find((event) => event.type === "step.finished");
    const jobUpdatedEvents = events.filter((event) => event.type === "job.updated");
    const persistedText = JSON.stringify({
      steps: persistedJob?.steps,
      stepStarted,
      stepFinished,
      jobUpdatedEvents
    });

    assert.equal(persistedText.includes("secret-token"), false);
    assert.equal(persistedText.includes("secret-bearer"), false);
    assert.equal(persistedText.includes("secret-output"), false);
    assert.equal(persistedText.includes("[url redacted]"), true);
    assert.equal(persistedText.includes("[redacted]"), true);
  });

  it("preserves final result while redacting result in job events", async () => {
    const store = new InMemoryJobStore();
    const job = await store.create({
      id: "job-result-redaction",
      task: "finish with report",
      workspacePath: "/workspace/job-result-redaction"
    });
    const finalTool: Tool = {
      name: "test.final",
      description: "Return a final report.",
      async execute() {
        return {
          observation: "final accepted",
          final:
            "Report URL https://example.test/path?token=secret-token\nAuthorization: Bearer secret-result\nCookie: session=secret-cookie"
        };
      }
    };
    const orchestrator = new AgentOrchestrator({
      store,
      sandbox: new SuccessfulCommandSandbox(),
      llm: new StaticLlmProvider({
        message: "I will finish.",
        toolCalls: [{ id: "call-1", name: finalTool.name, input: {} }]
      }),
      tools: [finalTool]
    });

    const result = await orchestrator.run(job.id);
    const persistedJob = await store.get(job.id);
    const events = await store.getEvents(job.id);
    const jobFinished = events.find((event) => event.type === "job.finished");
    const jobUpdatedEvents = events.filter((event) => event.type === "job.updated");
    const persistedText = JSON.stringify({
      jobFinished,
      jobUpdatedEvents
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.result?.includes("secret-result"), true);
    assert.equal(result.result?.includes("secret-token"), true);
    assert.equal(result.result?.includes("secret-cookie"), true);
    assert.equal(persistedJob?.result?.includes("secret-result"), true);
    assert.equal(persistedJob?.result?.includes("secret-token"), true);
    assert.equal(persistedJob?.result?.includes("secret-cookie"), true);
    assert.equal(persistedText.includes("secret-result"), false);
    assert.equal(persistedText.includes("secret-token"), false);
    assert.equal(persistedText.includes("secret-cookie"), false);
    assert.equal(persistedText.includes("[url redacted]"), true);
    assert.equal(persistedText.includes("[redacted]"), true);
    assert.equal(persistedText.includes("resultPreview"), true);
    assert.equal(persistedText.includes("resultBytes"), true);
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

class SecretOutputSandbox extends SuccessfulCommandSandbox {
  override async exec(): Promise<SandboxResult> {
    return {
      stdout: "Authorization: Bearer secret-output\n",
      stderr: "https://example.test/path?api_key=secret-token\n",
      exitCode: 0,
      durationMs: 12
    };
  }
}

class FailingDiagnosticEventStore extends InMemoryJobStore {
  constructor(private readonly failingTypes: JobEventType[]) {
    super();
  }

  override async appendEvent(event: JobEvent): Promise<void> {
    if (this.failingTypes.includes(event.type)) {
      throw new Error(`append failed for ${event.type}`);
    }

    await super.appendEvent(event);
  }
}

async function withSilencedConsoleWarn(fn: () => Promise<void>): Promise<void> {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await fn();
  } finally {
    console.warn = originalWarn;
  }
}
