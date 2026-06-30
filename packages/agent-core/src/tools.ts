import { z } from "zod";
import type { Tool } from "./types.js";

const shellInput = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional()
});

const finishInput = z.object({
  report: z.string().min(1)
});

export const shellExecTool: Tool = {
  name: "shell.exec",
  description: "Run a command inside the job sandbox and return stdout, stderr, and exit code.",
  async execute(input, context) {
    const parsed = shellInput.parse(input);
    const result = await context.sandbox.exec(context.job.id, parsed);
    const observation = [
      `exitCode=${result.exitCode}`,
      result.stdout ? `stdout:\n${result.stdout}` : undefined,
      result.stderr ? `stderr:\n${result.stderr}` : undefined
    ]
      .filter(Boolean)
      .join("\n");

    return { observation };
  }
};

export const finishTool: Tool = {
  name: "report.finish",
  description: "Finish the job with a human-readable report.",
  async execute(input) {
    const parsed = finishInput.parse(input);
    return {
      observation: "Final report accepted.",
      final: parsed.report
    };
  }
};

export const defaultTools = [shellExecTool, finishTool];
