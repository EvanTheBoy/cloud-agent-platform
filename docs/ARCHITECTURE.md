# Architecture

## Goal

Build a platform where a user submits a natural-language task, the system starts an autonomous cloud agent, and the agent iterates until it returns a final result.

Example task:

> Read this repository, find all TODO comments, and generate a report.

## Core Components

1. **API Server**
   - Accepts task submissions.
   - Creates job records.
   - Streams state and logs over WebSocket.
   - Exposes job results and artifacts.

2. **Scheduler / Queue**
   - Decouples request handling from execution.
   - Supports retries, concurrency limits, cancellation, and tenant quotas.
   - Local demo uses an in-memory queue.
   - Production can use BullMQ/Redis or Temporal.

3. **Agent Orchestrator**
   - Maintains step-by-step state.
   - Sends context to an LLM.
   - Parses tool calls.
   - Executes tools in a sandbox.
   - Feeds observations back into the next LLM step.
   - Stops on final answer, max steps, cancellation, or policy violation.

4. **Sandbox Runtime**
   - Creates one workspace per job.
   - Executes commands with timeouts and allowlisted capabilities.
   - Captures stdout, stderr, exit code, and duration.
   - Production isolation options: Docker, Kubernetes Jobs, Firecracker microVMs.

5. **LLM Provider**
   - Interface-based adapter for OpenAI, Anthropic, or local models.
   - Produces either final messages or structured tool calls.
   - Demo provider uses deterministic heuristics so the project runs without API keys.

6. **Tool Router**
   - Converts structured tool calls into sandbox operations.
   - Example tools: `shell.exec`, `fs.read`, `fs.write`, `report.finish`.
   - Enforces policy before execution.

## Execution Flow

```text
User -> API -> Job Store -> Queue -> Worker -> Agent Loop
                                      |        |
                                      |        v
                                      |      LLM Provider
                                      |        |
                                      v        v
                                  Sandbox <- Tool Router
                                      |
                                      v
                                Logs / Artifacts
```

## Isolation Model

The demo uses `LocalSandbox`, which creates a job-specific directory and runs commands inside it with timeouts. That is enough for a local architecture demonstration, but production should replace it with a stronger executor:

- Docker containers for simple isolation.
- Kubernetes Jobs for horizontal scaling.
- Firecracker microVMs for stronger tenant isolation.

Required controls:

- Per-job filesystem.
- CPU, memory, process, and network limits.
- Command timeout.
- No host credential mounting.
- Egress policy.
- Artifact scanning before returning results.
- Full audit log of commands and file mutations.

## Extensibility

The code is intentionally interface-driven:

- `JobStore` can become Postgres.
- `JobQueue` can become BullMQ or Temporal.
- `LlmProvider` can become OpenAI/Anthropic.
- `Sandbox` can become Docker/Firecracker.
- `Tool` registry can add browser automation, repo search, package install, tests, and deployment tools.
