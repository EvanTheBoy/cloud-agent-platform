export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type AgentRole = "system" | "user" | "assistant" | "tool";

export interface AgentMessage {
  role: AgentRole;
  content: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmResponse {
  message: string;
  toolCalls: ToolCall[];
  final?: string;
}

export interface AgentStep {
  index: number;
  thought: string;
  toolCall?: ToolCall;
  observation?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface AgentJob {
  id: string;
  task: string;
  status: JobStatus;
  workspacePath: string;
  steps: AgentStep[];
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type JobEventType = "job.created" | "job.updated" | "step.started" | "step.finished" | "job.finished";

export interface JobEvent {
  type: JobEventType;
  jobId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface CreateJobInput {
  id?: string;
  task: string;
}

export interface JobStore {
  create(input: CreateJobInput & { workspacePath: string }): Promise<AgentJob>;
  get(id: string): Promise<AgentJob | undefined>;
  update(id: string, patch: Partial<Omit<AgentJob, "id" | "createdAt">>): Promise<AgentJob>;
  list(): Promise<AgentJob[]>;
  appendEvent(event: JobEvent): Promise<void>;
  getEvents(jobId: string): Promise<JobEvent[]>;
}

export interface JobQueue {
  enqueue(jobId: string): Promise<void>;
}

export interface SandboxCommand {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export interface Sandbox {
  prepare(jobId: string): Promise<string>;
  exec(jobId: string, command: SandboxCommand): Promise<SandboxResult>;
  writeFile(jobId: string, relativePath: string, content: string): Promise<void>;
  readFile(jobId: string, relativePath: string): Promise<string>;
}

export interface ToolContext {
  job: AgentJob;
  sandbox: Sandbox;
}

export interface ToolResult {
  observation: string;
  final?: string;
}

export interface Tool {
  name: string;
  description: string;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export interface LlmProvider {
  complete(messages: AgentMessage[], tools: Tool[]): Promise<LlmResponse>;
}
