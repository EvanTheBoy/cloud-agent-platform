# Submission Notes

## What This Project Demonstrates

- Agent orchestration loop with iterative LLM reasoning and tool execution.
- Queue-based scheduling boundary between API and workers.
- Sandboxed command execution abstraction.
- Streaming logs and job status.
- Clear path from local demo to production cloud architecture.

## Why TypeScript

This system is primarily a cloud orchestration platform. The hard parts are async workflows, queues, state transitions, streaming logs, tool routing, API contracts, and dashboard integration. TypeScript fits those needs well while still allowing Python, Bash, and Node execution inside sandbox workers.

## Suggested Demo Script

1. Start the API with `npm run dev`.
2. Submit a task to `/jobs`.
3. Watch job events update from `queued` to `running` to `succeeded`.
4. Show that each agent step records thought, action, observation, and final report.
5. Explain how local adapters map to production services.

## Future Work

- Postgres persistence with row-level tenant isolation.
- BullMQ or Temporal worker fleet.
- Docker sandbox executor.
- Web UI with live WebSocket event stream.
- LLM provider adapters for OpenAI and Anthropic.
- Artifact viewer and downloadable reports.
- Policy engine for network, filesystem, and command allowlists.
