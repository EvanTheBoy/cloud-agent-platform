import { nanoid } from "nanoid";
import type { AgentMessage, LlmProvider, LlmResponse, Tool } from "./types.js";

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

export class OpenAiCompatibleProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: OpenAiProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.model = options.model ?? "gpt-4.1-mini";
  }

  async complete(messages: AgentMessage[], tools: Tool[]): Promise<LlmResponse> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
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

    const payload = (await response.json().catch(() => ({}))) as OpenAiChatResponse;
    if (!response.ok) {
      throw new Error(`OpenAI-compatible API request failed: ${payload.error?.message ?? response.statusText}`);
    }

    const message = payload.choices?.[0]?.message;
    const content = message?.content?.trim() ?? "";
    const toolNameByApiName = new Map(tools.map((tool) => [toOpenAiToolName(tool.name), tool.name]));
    const toolCalls =
      message?.tool_calls?.map((call) => ({
        id: call.id ?? nanoid(),
        name: toolNameByApiName.get(call.function?.name ?? "") ?? call.function?.name ?? "",
        input: this.parseArguments(call.function?.arguments ?? "{}")
      })) ?? [];

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

  private parseArguments(rawArguments: string): Record<string, unknown> {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tool arguments must be a JSON object.");
    }

    return parsed as Record<string, unknown>;
  }
}
