---
name: save-context
description: Save the agent's full context (system prompt, identity, memory, tools, agents, schedules, channels, snapshots) to a file on the host. Use when asked to "save context", "dump context", "export context", or "show what you see".
allowed-tools: Bash, Read, save_context
---

# Save Agent Context

You MUST follow these steps EXACTLY. Do NOT skip steps. Do NOT summarize or paraphrase file contents.

## Step 1: Read all source files

Use the `Read` tool to read each of these files. Read them NOW, before doing anything else:

1. `/workspace/context-dump.md`
2. `/workspace/CLAUDE.md`
3. `/workspace/group/CLAUDE.md`
4. `/workspace/context/00-IDENTITY.md`
5. `/workspace/context/01-SOUL.md`
6. `/workspace/context/02-USER.md`
7. `/workspace/context/03-TOOLS.md`
8. `/workspace/context/04-AGENTS.md`
9. `/workspace/context/05-HEARTBEAT.md`
10. `/workspace/context/06-CHANNELS.md`

Then use `Bash` to run: `ls /workspace/snapshots/*.json /workspace/snapshots/**/*.json 2>/dev/null`

Then use `Read` to read each JSON file found.

Then use `Bash` to run: `echo "HOME=$HOME"; echo "NODE_VERSION=$(node --version 2>/dev/null)"; echo "BUN_VERSION=$(bun --version 2>/dev/null)"; ls /workspace/extra/ 2>/dev/null || echo "no extra mounts"`

## Step 2: Assemble output

Build one markdown string by concatenating all the file contents you just read. Use this EXACT template — replace each `<<<PASTE>>>` with the COMPLETE, UNMODIFIED contents of the file you read in Step 1:

```
# Context Dump
<<<PASTE contents of /workspace/context-dump.md>>>

# Container Instructions
<<<PASTE contents of /workspace/CLAUDE.md>>>

# Group Memory
<<<PASTE contents of /workspace/group/CLAUDE.md>>>

# 00-IDENTITY.md
<<<PASTE contents of /workspace/context/00-IDENTITY.md>>>

# 01-SOUL.md
<<<PASTE contents of /workspace/context/01-SOUL.md>>>

# 02-USER.md
<<<PASTE contents of /workspace/context/02-USER.md>>>

# 03-TOOLS.md
<<<PASTE contents of /workspace/context/03-TOOLS.md>>>

# 04-AGENTS.md
<<<PASTE contents of /workspace/context/04-AGENTS.md>>>

# 05-HEARTBEAT.md
<<<PASTE contents of /workspace/context/05-HEARTBEAT.md>>>

# 06-CHANNELS.md
<<<PASTE contents of /workspace/context/06-CHANNELS.md>>>

# Snapshots
<<<For each .json file: include filename as ## header, then paste contents in a json code fence>>>

# Environment
<<<PASTE bash output>>>
```

If a file was not found or empty, write `_(not found)_` under its header.

## Step 3: Save

Call `save_context` with the assembled string as the `content` parameter.

## IMPORTANT

- <<<PASTE>>> means the LITERAL file contents from your Read tool results. Copy them character-for-character.
- Do NOT write descriptions of what the files contain. Do NOT summarize. Do NOT reformat.
- Do NOT skip the Read step and write from memory. You MUST read the files first.
- The output should be thousands of lines long. If your output is short, you did it wrong.
- Do NOT include secrets, tokens, or API keys from environment variables.
