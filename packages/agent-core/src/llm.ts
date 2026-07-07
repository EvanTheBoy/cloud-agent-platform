import { nanoid } from "nanoid";
import type { AgentMessage, LlmDiagnostics, LlmProvider, LlmResponse, Tool } from "./types.js";
import { previewDiagnosticText, redactSensitiveText } from "./diagnostics.js";
import type { MetricsRecorder } from "./metrics.js";
import { recordIncrement, recordObservation } from "./metrics.js";

export class DemoLlmProvider implements LlmProvider {
  async complete(messages: AgentMessage[], _tools: Tool[]): Promise<LlmResponse> {
    const toolMessages = messages.filter((message) => message.role === "tool");
    const userTask = messages.find((message) => message.role === "user")?.content ?? "";

    if (toolMessages.length === 0) {
      return {
        message: "I need to inspect the workspace for TODO markers before writing the report.",
        toolCalls: [
          {
            id: nanoid(),
            name: "shell.exec",
            input: {
              command: "sh",
              args: ["-lc", "find . -type f ! -path './node_modules/*' ! -path './dist/*' -print0 | xargs -0 grep -nE 'TODO|FIXME' 2>/dev/null || true"],
              timeoutMs: 30_000
            }
          }
        ]
      };
    }

    const lastObservation = toolMessages.at(-1)?.content ?? "";
    const hasTodoHits = lastObservation.includes(":");
    const report = hasTodoHits
      ? `Task: ${userTask}\n\nTODO/FIXME findings:\n\n${lastObservation}\n\nRecommendation: review each finding, assign an owner, and convert high-priority comments into tracked issues.`
      : `Task: ${userTask}\n\nNo TODO or FIXME comments were found in the scanned workspace.`;

    return {
      message: "I have enough evidence to produce the final report.",
      toolCalls: [
        {
          id: nanoid(),
          name: "report.finish",
          input: { report }
        }
      ],
      final: report
    };
  }
}

interface OpenAiProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  metrics?: MetricsRecorder;
}

interface OpenAiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAiToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAiChatChoice {
  message?: {
    content?: string | null;
    tool_calls?: OpenAiToolCall[];
  };
}

interface OpenAiChatResponse {
  choices?: OpenAiChatChoice[];
  error?: {
    message?: string;
  };
}

const toolSchemas: Record<string, Record<string, unknown>> = {
  "shell.exec": {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        description: "Executable to run inside the job sandbox."
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Command arguments."
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: 120000,
        description: "Command timeout in milliseconds."
      }
    },
    required: ["command"]
  },
  "report.finish": {
    type: "object",
    additionalProperties: false,
    properties: {
      report: {
        type: "string",
        description: "The final human-readable job report."
      }
    },
    required: ["report"]
  }
};

const toOpenAiToolName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");
const RAW_ARGUMENTS_PREVIEW_LIMIT = 500;

export class OpenAiCompatibleProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly metrics?: MetricsRecorder;

  constructor(options: OpenAiProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.model = options.model ?? "gpt-4.1-mini";
    this.metrics = options.metrics;
  }

  async complete(messages: AgentMessage[], tools: Tool[], diagnostics?: LlmDiagnostics): Promise<LlmResponse> {
    const startedAt = Date.now();
    await diagnostics?.({
      type: "llm.request.started",
      payload: {
        provider: "openai-compatible",
        model: this.model,
        baseUrlHost: this.baseUrlHost(),
        messageCount: messages.length,
        toolCount: tools.length
      }
    });

    const requestUrl = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    let response: Response;
    let payload: OpenAiChatResponse;

    try {
      response = await fetch(requestUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          messages: this.toOpenAiMessages(messages),
          tools: tools.map((tool) => {
            const apiName = toOpenAiToolName(tool.name);
            return {
              type: "function",
              function: {
                name: apiName,
                description: `${tool.description} Internal tool name: ${tool.name}.`,
                parameters: toolSchemas[tool.name] ?? {
                  type: "object",
                  additionalProperties: true
                }
              }
            };
          }),
          tool_choice: "auto"
        })
      });

      payload = (await response.json().catch(() => ({}))) as OpenAiChatResponse;
    } catch (error) {
      const errorMessage = redactSensitiveText(error instanceof Error ? error.message : String(error));
      this.recordRequestMetrics(Date.now() - startedAt, "failure");
      await diagnostics?.({
        type: "llm.request.failed",
        payload: {
          provider: "openai-compatible",
          model: this.model,
          baseUrlHost: this.baseUrlHost(),
          durationMs: Date.now() - startedAt,
          error: errorMessage
        }
      });
      throw new Error(errorMessage);
    }

    if (!response.ok) {
      const errorMessage = redactSensitiveText(payload.error?.message ?? response.statusText);
      this.recordRequestMetrics(Date.now() - startedAt, "failure", response.status);
      await diagnostics?.({
        type: "llm.request.failed",
        payload: {
          provider: "openai-compatible",
          model: this.model,
          baseUrlHost: this.baseUrlHost(),
          status: response.status,
          durationMs: Date.now() - startedAt,
          error: errorMessage
        }
      });
      throw new Error(`OpenAI-compatible API request failed: ${errorMessage}`);
    }

    this.recordRequestMetrics(Date.now() - startedAt, "success", response.status);
    await diagnostics?.({
      type: "llm.response.received",
      payload: {
        provider: "openai-compatible",
        model: this.model,
        status: response.status,
        choiceCount: payload.choices?.length ?? 0,
        toolCallCount: payload.choices?.[0]?.message?.tool_calls?.length ?? 0,
        durationMs: Date.now() - startedAt
      }
    });

    const message = payload.choices?.[0]?.message;
    const content = message?.content?.trim() ?? "";
    const toolNameByApiName = new Map(tools.map((tool) => [toOpenAiToolName(tool.name), tool.name]));
    const toolCalls: LlmResponse["toolCalls"] = [];
    for (const call of message?.tool_calls ?? []) {
      const toolName = toolNameByApiName.get(call.function?.name ?? "") ?? call.function?.name ?? "";
      const rawArguments = call.function?.arguments ?? "{}";
      toolCalls.push({
        id: call.id ?? nanoid(),
        name: toolName,
        input: await this.parseArguments(rawArguments, toolName, diagnostics)
      });
    }

    if (toolCalls.length > 0) {
      return {
        message: content || `Calling ${toolCalls.map((call) => call.name).join(", ")}.`,
        toolCalls
      };
    }

    if (content) {
      return {
        message: content,
        toolCalls: [
          {
            id: nanoid(),
            name: "report.finish",
            input: { report: content }
          }
        ],
        final: content
      };
    }

    throw new Error("OpenAI-compatible API returned no content or tool calls.");
  }

  private toOpenAiMessages(messages: AgentMessage[]): OpenAiChatMessage[] {
    return messages.map((message) => {
      if (message.role === "tool") {
        return {
          role: "user",
          content: `Tool observation:\n${message.content}`
        };
      }

      return {
        role: message.role,
        content: message.content
      };
    });
  }

  private async parseArguments(
    rawArguments: string,
    toolName: string,
    diagnostics?: LlmDiagnostics
  ): Promise<Record<string, unknown>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArguments) as unknown;
    } catch (error) {
      this.recordParseFailure(toolName, "invalid_json");
      await this.emitToolArgumentsParseFailed(
        rawArguments,
        toolName,
        redactSensitiveText(error instanceof Error ? error.message : String(error)),
        diagnostics
      );
      throw error;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.recordParseFailure(toolName, "not_object");
      await this.emitToolArgumentsParseFailed(rawArguments, toolName, "Tool arguments must be a JSON object.", diagnostics, "not_object");
      throw new Error("Tool arguments must be a JSON object.");
    }

    return parsed as Record<string, unknown>;
  }

  private async emitToolArgumentsParseFailed(
    rawArguments: string,
    toolName: string,
    parseError: string,
    diagnostics?: LlmDiagnostics,
    reason = "invalid_json"
  ): Promise<void> {
    await diagnostics?.({
      type: "llm.tool_arguments_parse_failed",
      payload: {
        provider: "openai-compatible",
        model: this.model,
        baseUrlHost: this.baseUrlHost(),
        toolName,
        reason,
        rawArgumentsPreview: previewDiagnosticText(rawArguments, RAW_ARGUMENTS_PREVIEW_LIMIT),
        rawArgumentsLength: rawArguments.length,
        parseError
      }
    });
  }

  private baseUrlHost(): string {
    try {
      return new URL(this.baseUrl).host;
    } catch {
      return "unknown";
    }
  }

  private recordRequestMetrics(durationMs: number, outcome: "success" | "failure", status?: number): void {
    const labels = {
      provider: "openai-compatible",
      model: this.model,
      outcome,
      status: status === undefined ? undefined : String(status)
    };
    recordObservation(this.metrics, "agent_llm_request_duration_ms", durationMs, labels);
    if (outcome === "failure") {
      recordIncrement(this.metrics, "agent_llm_request_failures_total", {
        provider: "openai-compatible",
        model: this.model,
        status: status === undefined ? undefined : String(status)
      });
    }
  }

  private recordParseFailure(toolName: string, reason: string): void {
    recordIncrement(this.metrics, "agent_llm_tool_argument_parse_failures_total", {
      provider: "openai-compatible",
      model: this.model,
      toolName,
      reason
    });
  }
}
