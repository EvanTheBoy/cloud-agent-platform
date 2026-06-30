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

export class OpenAiProviderPlaceholder implements LlmProvider {
  async complete(_messages: AgentMessage[], _tools: Tool[]): Promise<LlmResponse> {
    throw new Error("OpenAI provider is intentionally left as an adapter boundary. Wire the official SDK here for production.");
  }
}
