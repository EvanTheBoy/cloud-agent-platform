import type { AgentJob, AgentMessage, AgentStep, JobStore, LlmProvider, Sandbox, Tool } from "./types.js";

const now = () => new Date().toISOString();

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

    job = await this.options.store.update(job.id, { status: "running" });

    const messages: AgentMessage[] = [
      {
        role: "system",
        content: "You are an autonomous cloud coding agent. Use tools to inspect the sandbox, then finish with a concise report."
      },
      { role: "user", content: job.task }
    ];

    try {
      for (let index = 0; index < this.maxSteps; index += 1) {
        const response = await this.options.llm.complete(messages, [...this.toolsByName.values()]);
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

        const result = await tool.execute(toolCall.input, { job, sandbox: this.options.sandbox });
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
}
