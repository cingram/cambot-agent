#!/usr/bin/env bun
/**
 * bus — CLI tool for agent messaging and management.
 *
 * Messaging (writes IPC files, requires running host):
 *   bun run scripts/bus-send.ts send -a <id> "Your message"
 *   bun run scripts/bus-send.ts send -g <folder> "Your message"
 *   bun run scripts/bus-send.ts send "Message to main group"
 *   bun run scripts/bus-send.ts "Message to main group"          (implicit send)
 *
 * Agent management (direct DB, no host required):
 *   bun run scripts/bus-send.ts list
 *   bun run scripts/bus-send.ts show <id>
 *   bun run scripts/bus-send.ts create <id> --name "Name" [options]
 *   bun run scripts/bus-send.ts update <id> [options]
 *   bun run scripts/bus-send.ts delete <id>
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const PROJECT_ROOT = path.resolve(import.meta.dir, '..');
const IPC_DIR = path.join(PROJECT_ROOT, 'data', 'ipc', '_bus');
const INBOUND_DIR = path.join(IPC_DIR, 'inbound');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'cambot.sqlite');

// ── Subcommand routing ──────────────────────────────────────────

const args = process.argv.slice(2);
const subcommand = args[0] ?? '';

async function main(): Promise<void> {
  // Legacy flag compat: --list / -l anywhere in args
  if (args.includes('--list') || args.includes('-l')) {
    await listAgents();
    return;
  }

  switch (subcommand) {
    case 'list':
      await listAgents();
      break;
    case 'show':
      await showAgent(args.slice(1));
      break;
    case 'tools':
      await showTools(args.slice(1));
      break;
    case 'create':
      await createAgent(args.slice(1));
      break;
    case 'update':
      await updateAgent(args.slice(1));
      break;
    case 'delete':
      await deleteAgent(args.slice(1));
      break;
    case 'send':
      sendMessage(args.slice(1));
      break;
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      break;
    default:
      // No recognized subcommand — treat entire args as implicit "send"
      if (subcommand.startsWith('-') || subcommand.length > 0) {
        sendMessage(args);
      } else {
        printUsage();
      }
      break;
  }
}

main();

// ── Send message ────────────────────────────────────────────────

function sendMessage(sendArgs: string[]): void {
  let agent: string | undefined;
  let group: string | undefined;
  let timeout = '300';
  let poll = '500';
  const positionals: string[] = [];

  for (let i = 0; i < sendArgs.length; i++) {
    const arg = sendArgs[i];
    if ((arg === '-a' || arg === '--agent') && sendArgs[i + 1]) {
      agent = sendArgs[++i];
    } else if ((arg === '-g' || arg === '--group') && sendArgs[i + 1]) {
      group = sendArgs[++i];
    } else if ((arg === '-t' || arg === '--timeout') && sendArgs[i + 1]) {
      timeout = sendArgs[++i];
    } else if ((arg === '-p' || arg === '--poll') && sendArgs[i + 1]) {
      poll = sendArgs[++i];
    } else if (!arg.startsWith('-')) {
      positionals.push(arg);
    }
  }

  const message = positionals.join(' ');
  if (!message) {
    console.error('No message provided.\n');
    printUsage();
    process.exit(1);
  }

  const requestId = randomUUID();
  fs.mkdirSync(INBOUND_DIR, { recursive: true });
  fs.mkdirSync(RESPONSES_DIR, { recursive: true });

  const request = { id: requestId, message, agent, group, senderName: 'Bus CLI' };
  fs.writeFileSync(path.join(INBOUND_DIR, `${requestId}.json`), JSON.stringify(request));

  const target = agent ? `agent:${agent}` : group ? `group:${group}` : 'main group';
  console.log(`Sent to ${target} [${requestId.slice(0, 8)}]`);
  console.log('Waiting for response...\n');

  const timeoutMs = parseInt(timeout, 10) * 1000;
  const pollMs = parseInt(poll, 10);
  const responseFile = path.join(RESPONSES_DIR, `${requestId}.json`);
  const startTime = Date.now();

  const timer = setInterval(() => {
    if (fs.existsSync(responseFile)) {
      clearInterval(timer);
      let response: { id: string; status: string; text: string; durationMs?: number };
      try {
        response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
        fs.unlinkSync(responseFile);
      } catch {
        console.error('Failed to read response file');
        process.exit(1);
      }

      if (response.status === 'error') {
        console.error(response.text);
        if (response.durationMs) console.error(`\n(${formatDuration(response.durationMs)})`);
        process.exit(1);
      }

      console.log(response.text);
      if (response.durationMs) {
        console.log(`\n(${formatDuration(response.durationMs)})`);
      }
      process.exit(0);
    }

    if (Date.now() - startTime > timeoutMs) {
      clearInterval(timer);
      console.error(`Timeout after ${timeout}s — host may not be running`);
      const inboundFile = path.join(INBOUND_DIR, `${requestId}.json`);
      if (fs.existsSync(inboundFile)) {
        fs.unlinkSync(inboundFile);
        console.error('(Request was never picked up — is the host running?)');
      }
      process.exit(1);
    }
  }, pollMs);
}

// ── List agents ─────────────────────────────────────────────────

async function listAgents(): Promise<void> {
  const db = await openDb(true);
  try {
    const agents = db
      .query('SELECT id, name, description, provider, model, channels, tool_policy FROM registered_agents ORDER BY name')
      .all() as { id: string; name: string; description: string; provider: string; model: string; channels: string; tool_policy: string | null }[];

    if (agents.length === 0) {
      console.log('No registered agents.');
      return;
    }

    console.log('Available agents:\n');
    for (const agent of agents) {
      const channels = JSON.parse(agent.channels || '[]').join(', ');
      console.log(`  ${agent.id}`);
      console.log(`    Name:     ${agent.name}`);
      if (agent.description) console.log(`    Desc:     ${agent.description}`);
      console.log(`    Provider: ${agent.provider} / ${agent.model}`);
      const policy = agent.tool_policy ? JSON.parse(agent.tool_policy) : null;
      const preset = policy?.preset ?? (policy?.allow ? 'custom' : 'readonly');
      console.log(`    Policy:   ${preset}`);
      if (channels) console.log(`    Channels: ${channels}`);
      console.log();
    }
  } finally {
    db.close();
  }
}

// ── Show agent detail ───────────────────────────────────────────

async function showAgent(showArgs: string[]): Promise<void> {
  const id = showArgs[0];
  if (!id) {
    console.error('Usage: show <agent-id>');
    process.exit(1);
  }

  const db = await openDb(true);
  try {
    const row = db.query('SELECT * FROM registered_agents WHERE id = ?').get(id) as Record<string, unknown> | null;
    if (!row) {
      console.error(`Agent "${id}" not found.`);
      process.exit(1);
    }

    console.log(`Agent: ${row.id}\n`);
    console.log(`  Name:          ${row.name}`);
    console.log(`  Description:   ${row.description || '(none)'}`);
    console.log(`  Folder:        ${row.folder}`);
    console.log(`  Provider:      ${row.provider} / ${row.model}`);
    console.log(`  Channels:      ${formatJsonArray(row.channels as string)}`);
    console.log(`  MCP Servers:   ${formatJsonArray(row.mcp_servers as string)}`);
    console.log(`  Tools:         ${formatJsonArray(row.tools as string)}`);
    console.log(`  Concurrency:   ${row.concurrency}`);
    console.log(`  Timeout:       ${formatDuration(row.timeout_ms as number)}`);
    console.log(`  Is Main:       ${row.is_main === 1 ? 'yes' : 'no'}`);
    if (row.temperature != null) console.log(`  Temperature:   ${row.temperature}`);
    if (row.max_tokens != null) console.log(`  Max Tokens:    ${row.max_tokens}`);
    if (row.base_url) console.log(`  Base URL:      ${row.base_url}`);
    if (row.system_prompt) console.log(`  System Prompt: ${(row.system_prompt as string).slice(0, 100)}...`);
    if (row.soul) console.log(`  Soul:          ${(row.soul as string).slice(0, 100)}...`);
    if (row.tool_policy) console.log(`  Tool Policy:   ${row.tool_policy}`);
    if (row.secret_keys && row.secret_keys !== '[]') console.log(`  Secret Keys:   ${formatJsonArray(row.secret_keys as string)}`);
    console.log(`  Created:       ${row.created_at}`);
    console.log(`  Updated:       ${row.updated_at}`);
  } finally {
    db.close();
  }
}

// ── Show resolved tools ─────────────────────────────────────────

async function resolveToolPolicy(policyJson: string | null): Promise<{ sdk: string[]; mcp: string[] }> {
  if (!policyJson) return { sdk: [], mcp: [] };
  try {
    const { resolveToolList, resolveMcpToolList } = await import('../src/tools/tool-policy.js');
    const policy = JSON.parse(policyJson);
    return {
      sdk: resolveToolList(policy),
      mcp: resolveMcpToolList(policy),
    };
  } catch {
    return { sdk: [], mcp: [] };
  }
}

async function showTools(toolsArgs: string[]): Promise<void> {
  const id = toolsArgs[0];
  const db = await openDb(true);
  try {
    if (id) {
      // Show tools for a specific agent
      const row = db.query('SELECT id, name, tool_policy FROM registered_agents WHERE id = ?').get(id) as { id: string; name: string; tool_policy: string | null } | null;
      if (!row) {
        console.error(`Agent "${id}" not found.`);
        process.exit(1);
      }
      const { sdk, mcp } = await resolveToolPolicy(row.tool_policy);
      console.log(`${row.name} (${row.id}):\n`);
      if (row.tool_policy) {
        const policy = JSON.parse(row.tool_policy);
        console.log(`  Policy:     ${JSON.stringify(policy)}`);
      } else {
        console.log(`  Policy:     (none — no tools)`);
      }
      console.log(`  SDK Tools:  ${sdk.length > 0 ? sdk.join(', ') : '(none)'}`);
      console.log(`  MCP Tools:  ${mcp.length > 0 ? mcp.join(', ') : '(none)'}`);
      console.log(`  Bash:       ${sdk.includes('Bash') ? 'yes' : 'no'}`);
    } else {
      // Show tools for all agents
      const rows = db.query('SELECT id, name, tool_policy FROM registered_agents ORDER BY name').all() as { id: string; name: string; tool_policy: string | null }[];
      if (rows.length === 0) {
        console.log('No registered agents.');
        return;
      }
      console.log('Agent tool access:\n');
      for (const row of rows) {
        const { sdk, mcp } = await resolveToolPolicy(row.tool_policy);
        const preset = row.tool_policy ? (JSON.parse(row.tool_policy).preset ?? 'full') : '(none)';
        const hasBash = sdk.includes('Bash') ? 'yes' : 'no';
        console.log(`  ${row.id}`);
        console.log(`    Preset: ${preset}    Bash: ${hasBash}    SDK: ${sdk.length}    MCP: ${mcp.length}`);
        console.log(`    SDK: ${sdk.join(', ') || '(none)'}`);
        console.log(`    MCP: ${mcp.join(', ') || '(none)'}`);
        console.log();
      }
    }
  } finally {
    db.close();
  }
}

// ── Create agent ────────────────────────────────────────────────

async function createAgent(createArgs: string[]): Promise<void> {
  const id = createArgs[0];
  if (!id || id.startsWith('-')) {
    console.error('Usage: create <agent-id> --name "Name" [options]');
    console.error('\nRequired:');
    console.error('  --name <name>              Agent display name');
    console.error('\nOptional:');
    printAgentOptions();
    process.exit(1);
  }

  const opts = parseAgentOptions(createArgs.slice(1));

  if (!opts.name) {
    console.error('Error: --name is required for create.');
    process.exit(1);
  }

  const folder = opts.folder ?? id;
  const now = new Date().toISOString();

  const db = await openDb(false);
  try {
    // Validate folder uniqueness
    const existing = db.query('SELECT id FROM registered_agents WHERE folder = ?').get(folder) as { id: string } | null;
    if (existing) {
      console.error(`Error: folder "${folder}" is already used by agent "${existing.id}".`);
      process.exit(1);
    }

    // Validate ID uniqueness
    const existingId = db.query('SELECT id FROM registered_agents WHERE id = ?').get(id) as { id: string } | null;
    if (existingId) {
      console.error(`Error: agent "${id}" already exists. Use "update" to modify it.`);
      process.exit(1);
    }

    // Validate channel exclusivity
    const channels = opts.channels ?? [];
    if (channels.length > 0) {
      const allAgents = db.query('SELECT id, channels FROM registered_agents').all() as { id: string; channels: string }[];
      for (const row of allAgents) {
        const existing = JSON.parse(row.channels) as string[];
        for (const ch of channels) {
          if (existing.includes(ch)) {
            console.error(`Error: channel "${ch}" is already claimed by agent "${row.id}".`);
            process.exit(1);
          }
        }
      }
    }

    db.run(
      `INSERT INTO registered_agents
        (id, name, description, folder, channels, mcp_servers, capabilities,
         concurrency, timeout_ms, is_main, tool_policy,
         system_prompt, soul, provider, model, secret_keys,
         container_config, tools, temperature, max_tokens, base_url,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        opts.name,
        opts.description ?? '',
        folder,
        JSON.stringify(channels),
        JSON.stringify(opts.mcpServers ?? []),
        JSON.stringify(opts.capabilities ?? []),
        opts.concurrency ?? 1,
        opts.timeoutMs ?? 300_000,
        opts.isMain ? 1 : 0,
        opts.toolPolicy ?? null,
        opts.systemPrompt ?? null,
        opts.soul ?? null,
        opts.provider ?? 'claude',
        opts.model ?? 'claude-sonnet-4-6',
        JSON.stringify(opts.secretKeys ?? []),
        opts.containerConfig ?? null,
        JSON.stringify(opts.tools ?? []),
        opts.temperature ?? null,
        opts.maxTokens ?? null,
        opts.baseUrl ?? null,
        now,
        now,
      ],
    );

    console.log(`Created agent "${id}" (folder: ${folder})`);
  } finally {
    db.close();
  }
}

// ── Update agent ────────────────────────────────────────────────

async function updateAgent(updateArgs: string[]): Promise<void> {
  const id = updateArgs[0];
  if (!id || id.startsWith('-')) {
    console.error('Usage: update <agent-id> [options]');
    console.error('\nOptions:');
    console.error('  --name <name>              Agent display name');
    printAgentOptions();
    process.exit(1);
  }

  const opts = parseAgentOptions(updateArgs.slice(1));
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (opts.name !== undefined)        { setClauses.push('name = ?');          values.push(opts.name); }
  if (opts.description !== undefined) { setClauses.push('description = ?');   values.push(opts.description); }
  if (opts.provider !== undefined)    { setClauses.push('provider = ?');      values.push(opts.provider); }
  if (opts.model !== undefined)       { setClauses.push('model = ?');         values.push(opts.model); }
  if (opts.channels !== undefined)    { setClauses.push('channels = ?');      values.push(JSON.stringify(opts.channels)); }
  if (opts.mcpServers !== undefined)  { setClauses.push('mcp_servers = ?');   values.push(JSON.stringify(opts.mcpServers)); }
  if (opts.tools !== undefined)       { setClauses.push('tools = ?');         values.push(JSON.stringify(opts.tools)); }
  if (opts.capabilities !== undefined){ setClauses.push('capabilities = ?');  values.push(JSON.stringify(opts.capabilities)); }
  if (opts.concurrency !== undefined) { setClauses.push('concurrency = ?');   values.push(opts.concurrency); }
  if (opts.timeoutMs !== undefined)   { setClauses.push('timeout_ms = ?');    values.push(opts.timeoutMs); }
  if (opts.isMain !== undefined)      { setClauses.push('is_main = ?');       values.push(opts.isMain ? 1 : 0); }
  if (opts.systemPrompt !== undefined){ setClauses.push('system_prompt = ?'); values.push(opts.systemPrompt); }
  if (opts.soul !== undefined)        { setClauses.push('soul = ?');          values.push(opts.soul); }
  if (opts.temperature !== undefined) { setClauses.push('temperature = ?');   values.push(opts.temperature); }
  if (opts.maxTokens !== undefined)   { setClauses.push('max_tokens = ?');    values.push(opts.maxTokens); }
  if (opts.baseUrl !== undefined)     { setClauses.push('base_url = ?');      values.push(opts.baseUrl); }
  if (opts.secretKeys !== undefined)  { setClauses.push('secret_keys = ?');   values.push(JSON.stringify(opts.secretKeys)); }
  if (opts.toolPolicy !== undefined)  { setClauses.push('tool_policy = ?');   values.push(opts.toolPolicy); }

  if (setClauses.length === 0) {
    console.error('No fields to update. Pass at least one option.');
    process.exit(1);
  }

  setClauses.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  const db = await openDb(false);
  try {
    const existing = db.query('SELECT id FROM registered_agents WHERE id = ?').get(id);
    if (!existing) {
      console.error(`Agent "${id}" not found.`);
      process.exit(1);
    }

    // Validate channel exclusivity if channels are being updated
    if (opts.channels !== undefined && opts.channels.length > 0) {
      const allAgents = db.query('SELECT id, channels FROM registered_agents WHERE id != ?').all(id) as { id: string; channels: string }[];
      for (const row of allAgents) {
        const existing = JSON.parse(row.channels) as string[];
        for (const ch of opts.channels) {
          if (existing.includes(ch)) {
            console.error(`Error: channel "${ch}" is already claimed by agent "${row.id}".`);
            process.exit(1);
          }
        }
      }
    }

    db.run(`UPDATE registered_agents SET ${setClauses.join(', ')} WHERE id = ?`, values);
    console.log(`Updated agent "${id}".`);
  } finally {
    db.close();
  }
}

// ── Delete agent ────────────────────────────────────────────────

async function deleteAgent(deleteArgs: string[]): Promise<void> {
  const id = deleteArgs[0];
  if (!id || id.startsWith('-')) {
    console.error('Usage: delete <agent-id>');
    process.exit(1);
  }

  const db = await openDb(false);
  try {
    const existing = db.query('SELECT id, name FROM registered_agents WHERE id = ?').get(id) as { id: string; name: string } | null;
    if (!existing) {
      console.error(`Agent "${id}" not found.`);
      process.exit(1);
    }

    db.run('DELETE FROM registered_agents WHERE id = ?', [id]);
    console.log(`Deleted agent "${id}" (${existing.name}).`);
  } finally {
    db.close();
  }
}

// ── Option parsing ──────────────────────────────────────────────

interface AgentOptions {
  name?: string;
  description?: string;
  folder?: string;
  provider?: string;
  model?: string;
  channels?: string[];
  mcpServers?: string[];
  tools?: string[];
  capabilities?: string[];
  secretKeys?: string[];
  concurrency?: number;
  timeoutMs?: number;
  isMain?: boolean;
  systemPrompt?: string;
  soul?: string;
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
  toolPolicy?: string;
  containerConfig?: string;
}

function parseAgentOptions(optArgs: string[]): AgentOptions {
  const opts: AgentOptions = {};

  for (let i = 0; i < optArgs.length; i++) {
    const arg = optArgs[i];
    const next = () => {
      if (i + 1 >= optArgs.length) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }
      return optArgs[++i];
    };

    switch (arg) {
      case '--name':           opts.name = next();                          break;
      case '--description':    opts.description = next();                   break;
      case '--folder':         opts.folder = next();                        break;
      case '--provider':       opts.provider = next();                      break;
      case '--model':          opts.model = next();                         break;
      case '--channels':       opts.channels = parseCommaSep(next());       break;
      case '--mcp-servers':    opts.mcpServers = parseCommaSep(next());     break;
      case '--tools':          opts.tools = parseCommaSep(next());          break;
      case '--capabilities':   opts.capabilities = parseCommaSep(next());   break;
      case '--secret-keys':    opts.secretKeys = parseCommaSep(next());     break;
      case '--concurrency':    opts.concurrency = parseInt(next(), 10);     break;
      case '--timeout':        opts.timeoutMs = parseInt(next(), 10);       break;
      case '--is-main':        opts.isMain = true;                          break;
      case '--system-prompt':  opts.systemPrompt = readFileOrValue(next()); break;
      case '--soul':           opts.soul = readFileOrValue(next());         break;
      case '--temperature':    opts.temperature = parseFloat(next());       break;
      case '--max-tokens':     opts.maxTokens = parseInt(next(), 10);       break;
      case '--base-url':       opts.baseUrl = next();                       break;
      case '--tool-policy':    opts.toolPolicy = parseJson(arg, readFileOrValue(next())); break;
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }

  return opts;
}

function parseCommaSep(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

/** Validate and return a JSON string. Exits with an error if invalid. */
function parseJson(flag: string, value: string): string {
  try {
    JSON.parse(value);
  } catch {
    console.error(`Invalid JSON for ${flag}: ${value}`);
    console.error('Tip: PowerShell strips double quotes. Use escaped quotes or a file:');
    console.error(`  ${flag} '{\\"preset\\":\\"readonly\\"}'`);
    console.error(`  ${flag} @policy.json`);
    process.exit(1);
  }
  return value;
}

/** If value starts with @, read from file; otherwise use as-is. */
function readFileOrValue(value: string): string {
  if (value.startsWith('@')) {
    const filePath = value.slice(1);
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    return fs.readFileSync(filePath, 'utf-8');
  }
  return value;
}

// ── DB helper ───────────────────────────────────────────────────

async function openDb(_readOnly?: boolean) {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}`);
    console.error('Is the host initialized?');
    process.exit(1);
  }
  // Note: bun:sqlite on Windows (bun 1.3.9) crashes when passing an options
  // object in ESM mode. Omitting options defaults to read-write, which is fine.
  const { Database } = await import('bun:sqlite');
  return new Database(DB_PATH);
}

// ── Formatting helpers ──────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatJsonArray(json: string): string {
  const arr = JSON.parse(json || '[]') as string[];
  return arr.length > 0 ? arr.join(', ') : '(none)';
}

function printAgentOptions(): void {
  console.error('  --description <text>       Agent description');
  console.error('  --folder <name>            Workspace folder (default: agent id)');
  console.error('  --provider <name>          LLM provider (default: claude)');
  console.error('  --model <name>             Model name (default: claude-sonnet-4-6)');
  console.error('  --channels <a,b>           Comma-separated channel claims');
  console.error('  --mcp-servers <a,b>        Comma-separated MCP server names');
  console.error('  --tools <a,b>              Comma-separated tool names');
  console.error('  --capabilities <a,b>       Comma-separated capability tags');
  console.error('  --secret-keys <a,b>        Comma-separated env var names for secrets');
  console.error('  --concurrency <n>          Max concurrent containers (default: 1)');
  console.error('  --timeout <ms>             Container timeout in ms (default: 300000)');
  console.error('  --is-main                  Grant main-group privileges');
  console.error('  --system-prompt <text|@file>  System prompt (prefix with @ to read file)');
  console.error('  --soul <text|@file>        Soul/personality (prefix with @ to read file)');
  console.error('  --temperature <n>          Sampling temperature');
  console.error('  --max-tokens <n>           Max output tokens');
  console.error('  --base-url <url>           Custom API base URL');
  console.error('  --tool-policy <json|@file>  Tool policy (JSON or @file). Presets:');
  console.error('                               readonly  — Read,Glob,Grep,WebSearch,WebFetch (default)');
  console.error('                               minimal   — Read,Glob,Grep');
  console.error('                               sandboxed — Bash,Read,Write,Edit,Glob,Grep + utils');
  console.error('                               standard  — All minus teams/notebook');
  console.error('                               full      — All SDK + MCP tools');
  console.error('                               gateway   — Read,Glob,Grep + send_message only');
  console.error('                             SDK examples:');
  console.error('                               --tool-policy \'{"preset":"readonly"}\'');
  console.error('                               --tool-policy \'{"preset":"readonly","add":["Bash"]}\'');
  console.error('                               --tool-policy \'{"preset":"standard","deny":["Bash"]}\'');
  console.error('                               --tool-policy \'{"allow":["Read","Glob","Grep"]}\'');
  console.error('                             MCP examples:');
  console.error('                               --tool-policy \'{"preset":"readonly","mcp":{"add":["schedule_task"]}}\'');
  console.error('                               --tool-policy \'{"preset":"full","mcp":{"deny":["send_to_agent"]}}\'');
  console.error('                               --tool-policy \'{"mcp":{"allow":["send_message","list_tasks"]}}\'');
  console.error('                               --tool-policy @policy.json');
}

function printUsage(): void {
  console.log('bus — Agent messaging and management CLI\n');
  console.log('Messaging (requires running host):');
  console.log('  bun run scripts/bus-send.ts send -a <id> "message"');
  console.log('  bun run scripts/bus-send.ts send -g <folder> "message"');
  console.log('  bun run scripts/bus-send.ts send "message"');
  console.log('  bun run scripts/bus-send.ts "message"               (implicit send)\n');
  console.log('  Send options:');
  console.log('    -a, --agent <id>      Target a specific agent');
  console.log('    -g, --group <folder>  Target a specific group');
  console.log('    -t, --timeout <sec>   Response timeout (default: 300)');
  console.log('    -p, --poll <ms>       Poll interval (default: 500)\n');
  console.log('Agent management (direct DB, no host required):');
  console.log('  bun run scripts/bus-send.ts list');
  console.log('  bun run scripts/bus-send.ts show <id>');
  console.log('  bun run scripts/bus-send.ts tools [id]');
  console.log('  bun run scripts/bus-send.ts create <id> --name "Name" [options]');
  console.log('  bun run scripts/bus-send.ts update <id> [options]');
  console.log('  bun run scripts/bus-send.ts delete <id>\n');
  console.log('Examples:');
  console.log('  bun run scripts/bus-send.ts list');
  console.log('  bun run scripts/bus-send.ts show email-agent');
  console.log('  bun run scripts/bus-send.ts tools email-agent');
  console.log('  bun run scripts/bus-send.ts create my-agent --name "My Agent" --model claude-opus-4-6');
  console.log('  bun run scripts/bus-send.ts update my-agent --description "Updated desc" --channels web');
  console.log('  bun run scripts/bus-send.ts update my-agent --tool-policy @policy.json');
  console.log('  bun run scripts/bus-send.ts delete my-agent');
  console.log('  bun run scripts/bus-send.ts -a email-agent "What\'s in my inbox?"');
}
