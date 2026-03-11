---
name: save-context
description: Save the agent's full context (system prompt, identity, memory, tools, agents, schedules, channels, snapshots) to a file on the host. Use when asked to "save context", "dump context", "export context", or "show what you see".
allowed-tools: save_context
---

# Save Agent Context

Call the `save_context` tool. It reads all workspace context files automatically and sends them to the host. There is nothing for you to assemble — the tool handles everything.

If `save_context` is unavailable, say so. Do NOT attempt to assemble or write context yourself.
