import type {
  AgentJob,
  AgentMessage,
  AgentStep,
  JobEventType,
  JobStore,
  LlmProvider,
  Sandbox,
  SandboxCommand,
  SandboxResult,
  Tool
} from "./types.js";

const now = () => new Date().toISOString();
const OUTPUT_TRUNCATED_MARKER = "\n[output truncated]\n";

export interface AgentOrchestratorOptions {
  store: JobStore;
  sandbox: Sandbox;
  llm: LlmProvider;
  tools: Tool[];
  maxSteps?: number;
}

export class AgentOrchestrator {
  private readonly maxSteps: number;
  private readonly toolsByName: Map<string, Tool>;

  constructor(private readonly options: AgentOrchestratorOptions) {
    this.maxSteps = options.maxSteps ?? 8;
    this.toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
  }

  async run(jobId: string): Promise<AgentJob> {
    let job = await this.options.store.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    try {
      await this.options.sandbox.validateWorkspace(job.id, job.workspacePath);
      job = await this.options.store.update(job.id, { status: "running" });

      const messages: AgentMessage[] = [
        {
          role: "system",
          content: "You are an autonomous cloud coding agent. Use tools to inspect the sandbox, then finish with a concise report."
        },
        { role: "user", content: job.task }
      ];

      for (let index = 0; index < this.maxSteps; index += 1) {
        const currentJobId = job.id;
        const response = await this.options.llm.complete(messages, [...this.toolsByName.values()], async (event) => {
          await this.appendDiagnosticEvent(currentJobId, event.type, event.payload);
        });
        messages.push({ role: "assistant", content: response.message });

        const toolCall = response.toolCalls[0];
        if (!toolCall) {
          throw new Error("LLM did not produce a tool call or final answer");
        }

        const startedAt = now();
        const step: AgentStep = {
          index,
          thought: response.message,
          toolCall,
          startedAt
        };

        await this.options.store.appendEvent({
          type: "step.started",
          jobId: job.id,
          timestamp: startedAt,
          payload: { step }
        });

        const tool = this.toolsByName.get(toolCall.name);
        if (!tool) {
          throw new Error(`Unknown tool: ${toolCall.name}`);
        }

        const toolStartedAt = Date.now();
        await this.appendDiagnosticEvent(job.id, "tool.started", {
          toolName: tool.name,
          inputPreview: previewToolInput(tool.name, toolCall.input)
        });

        let result;
        try {
          result = await tool.execute(toolCall.input, {
            job,
            sandbox: new DiagnosticSandbox(this.options.sandbox, async (type, payload) => {
              await this.appendDiagnosticEvent(currentJobId, type, payload);
            })
          });
        } catch (error) {
          await this.appendDiagnosticEvent(job.id, "tool.failed", {
            toolName: tool.name,
            durationMs: Date.now() - toolStartedAt,
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }

        await this.appendDiagnosticEvent(job.id, "tool.finished", {
          toolName: tool.name,
          durationMs: Date.now() - toolStartedAt,
          observationBytes: Buffer.byteLength(result.observation, "utf8"),
          final: Boolean(result.final)
        });

        const finishedStep: AgentStep = {
          ...step,
          observation: result.observation,
          finishedAt: now()
        };
        messages.push({ role: "tool", content: result.observation });

        job = await this.options.store.update(job.id, {
          steps: [...job.steps, finishedStep],
          result: result.final ?? job.result
        });

        await this.options.store.appendEvent({
          type: "step.finished",
          jobId: job.id,
          timestamp: finishedStep.finishedAt ?? now(),
          payload: { step: finishedStep }
        });

        if (result.final) {
          job = await this.options.store.update(job.id, {
            status: "succeeded",
            result: result.final
          });
          await this.options.store.appendEvent({
            type: "job.finished",
            jobId: job.id,
            timestamp: now(),
            payload: { status: job.status, result: job.result }
          });
          return job;
        }
      }

      throw new Error(`Agent exceeded maxSteps=${this.maxSteps}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job = await this.options.store.update(job.id, {
        status: "failed",
        error: message
      });
      await this.options.store.appendEvent({
        type: "job.finished",
        jobId: job.id,
        timestamp: now(),
        payload: { status: job.status, error: message }
      });
      return job;
    }
  }

  private async appendDiagnosticEvent(jobId: string, type: JobEventType, payload: Record<string, unknown>): Promise<void> {
    await this.options.store.appendEvent({
      type,
      jobId,
      timestamp: now(),
      payload
    });
  }
}

type AppendDiagnosticEvent = (type: JobEventType, payload: Record<string, unknown>) => Promise<void>;

class DiagnosticSandbox implements Sandbox {
  constructor(
    private readonly inner: Sandbox,
    private readonly appendDiagnosticEvent: AppendDiagnosticEvent
  ) {}

  async prepare(jobId: string): Promise<string> {
    return await this.inner.prepare(jobId);
  }

  async validateWorkspace(jobId: string, expectedPath: string): Promise<void> {
    await this.inner.validateWorkspace(jobId, expectedPath);
  }

  async exec(jobId: string, command: SandboxCommand): Promise<SandboxResult> {
    const startedAt = Date.now();
    const timeoutMs = command.timeoutMs ?? 30_000;
    await this.appendDiagnosticEvent("sandbox.command.started", {
      command: command.command,
      argsCount: command.args?.length ?? 0,
      timeoutMs
    });

    try {
      const result = await this.inner.exec(jobId, command);
      await this.appendDiagnosticEvent("sandbox.command.finished", {
        command: command.command,
        argsCount: command.args?.length ?? 0,
        timeoutMs,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
        stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
        stdoutTruncated: result.stdout.includes(OUTPUT_TRUNCATED_MARKER),
        stderrTruncated: result.stderr.includes(OUTPUT_TRUNCATED_MARKER)
      });
      return result;
    } catch (error) {
      await this.appendDiagnosticEvent("sandbox.command.failed", {
        command: command.command,
        argsCount: command.args?.length ?? 0,
        timeoutMs,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async writeFile(jobId: string, relativePath: string, content: string): Promise<void> {
    await this.inner.writeFile(jobId, relativePath, content);
  }

  async readFile(jobId: string, relativePath: string): Promise<string> {
    return await this.inner.readFile(jobId, relativePath);
  }

  async importDirectory(jobId: string, sourcePath: string): Promise<void> {
    await this.inner.importDirectory(jobId, sourcePath);
  }
}

function previewToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (toolName === "shell.exec") {
    return {
      command: typeof input.command === "string" ? truncate(input.command, 200) : undefined,
      argsCount: Array.isArray(input.args) ? input.args.length : 0,
      timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined
    };
  }

  return sanitizeDiagnosticValue(input, 0) as Record<string, unknown>;
}

function sanitizeDiagnosticValue(value: unknown, depth: number): unknown {
  if (depth > 3) {
    return "[max depth]";
  }

  if (typeof value === "string") {
    return truncate(value, 500);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeDiagnosticValue(item, depth + 1));
  }

  if (typeof value === "object" && value) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 20)) {
      output[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeDiagnosticValue(item, depth + 1);
    }
    return output;
  }

  return String(value);
}

function isSensitiveKey(key: string): boolean {
  return /api[_-]?key|authorization|bearer|cookie|password|secret|token/i.test(key);
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...[truncated]` : value;
}
