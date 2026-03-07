/**
 * Dynamic Context File Generator
 *
 * Generates numbered .md files into data/ipc/{group}/context/ before each
 * container spawn. These files are read by the agent-runner's context-assembler
 * and injected into the system prompt alongside CLAUDE.md.
 *
 * Files are numbered to control injection order:
 *   01-SOUL.md, 02-USER.md, 03-TOOLS.md, 04-AGENTS.md, 05-HEARTBEAT.md, 06-CHANNELS.md
 */
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

// ── Types ────────────────────────────────────────────────────────────

interface McpServerInfo {
  name: string;
  transport: string;
  url: string;
}

interface AgentSummaryRow {
  id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
}

interface ScheduledTaskRow {
  id: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
}

interface WorkflowSummary {
  id: string;
  name: string;
  schedule?: { cron: string; timezone?: string };
}

interface ChatInfo {
  jid: string;
  name: string;
  channel: string;
  is_group: number;
}

export interface ContextFileDeps {
  mcpServers: McpServerInfo[];
  skillsDir: string;
  agents: AgentSummaryRow[];
  tasks: ScheduledTaskRow[];
  workflows: WorkflowSummary[];
  agentIdentity?: string;  // system_prompt from DB (or global template)
  agentSoul?: string;      // soul from DB (or global template)
  chatJid?: string;                    // current message's JID
  getChats?: () => ChatInfo[];         // getAllChats from db.ts
}

// ── Generators ───────────────────────────────────────────────────────

function generateToolsMd(deps: ContextFileDeps): string {
  const lines: string[] = ['## Tools & Skills\n'];

  // Core cambot-agent tools (only those NOT already in CLAUDE.md)
  lines.push('### cambot-agent (core)');
  lines.push('| Tool | Description |');
  lines.push('|------|-------------|');
  lines.push('| send_message | Send a message to the user or group |');
  lines.push('| schedule_task | Create recurring/one-time scheduled tasks |');
  lines.push('| list_tasks | List all scheduled tasks |');
  lines.push('| pause_task / resume_task / cancel_task | Task lifecycle |');
  lines.push('| register_group | Register a new group (main only) |');
  lines.push('| send_to_agent | Send a message to another persistent agent |');
  lines.push('| list_workflows / workflow_status | Query workflows |');
  lines.push('| run_workflow / pause_workflow / cancel_workflow | Workflow lifecycle |');
  lines.push('| delegate_to_worker | Delegate sub-task to a worker agent |');
  lines.push('');

  // Workflow builder MCP tools
  lines.push('### workflow-builder');
  lines.push('| Tool | Description |');
  lines.push('|------|-------------|');
  lines.push('| get_workflow | Get full workflow definition (steps, policy, schedule) |');
  lines.push('| create_workflow | Create a new workflow from structured definition |');
  lines.push('| update_workflow | Replace an existing workflow |');
  lines.push('| delete_workflow | Remove a workflow |');
  lines.push('| validate_workflow | Dry-run validation without saving |');
  lines.push('| clone_workflow | Copy an existing workflow with a new ID |');
  lines.push('| get_workflow_schema | List available step types, tools, operators |');
  lines.push('');

  // External MCP servers
  if (deps.mcpServers.length > 0) {
    for (const server of deps.mcpServers) {
      lines.push(`### ${server.name} (external)`);
      lines.push(`Connected via ${server.transport}. Tools discovered at runtime.`);
      lines.push('');
    }
  }

  // Skills
  const skills = scanSkills(deps.skillsDir);
  if (skills.length > 0) {
    lines.push('### Skills');
    lines.push('| Skill | Description |');
    lines.push('|-------|-------------|');
    for (const skill of skills) {
      lines.push(`| ${skill.name} | ${skill.description} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function generateAgentsMd(agents: AgentSummaryRow[]): string {
  if (agents.length === 0) {
    return '## Agents\n\nNo agents registered.\n';
  }

  const lines: string[] = ['## Agents\n'];
  lines.push('| Name | Provider | Model | Description |');
  lines.push('|------|----------|-------|-------------|');

  for (const agent of agents) {
    const desc = agent.description || '—';
    lines.push(`| ${agent.name} | ${agent.provider} | ${agent.model} | ${desc} |`);
  }

  lines.push('');
  return lines.join('\n');
}

function generateHeartbeatMd(tasks: ScheduledTaskRow[], workflows: WorkflowSummary[]): string {
  const lines: string[] = ['## Active Schedule\n'];

  // Active scheduled tasks
  const activeTasks = tasks.filter(t => t.status === 'active');
  if (activeTasks.length > 0) {
    lines.push('### Scheduled Tasks');
    for (const task of activeTasks.slice(0, 10)) {
      const schedule = task.schedule_type === 'cron'
        ? `cron: ${task.schedule_value}`
        : task.schedule_type === 'interval'
          ? `every ${Math.round(parseInt(task.schedule_value, 10) / 60000)}m`
          : `once at ${task.next_run || task.schedule_value}`;
      lines.push(`- **${task.id}**: ${task.prompt.slice(0, 60)}${task.prompt.length > 60 ? '...' : ''} (${schedule})`);
    }
    if (activeTasks.length > 10) {
      lines.push(`- _...and ${activeTasks.length - 10} more_`);
    }
    lines.push('');
  }

  // Scheduled workflows
  const scheduledWorkflows = workflows.filter(w => w.schedule);
  if (scheduledWorkflows.length > 0) {
    lines.push('### Workflow Schedules');
    for (const wf of scheduledWorkflows) {
      lines.push(`- **${wf.name}** (${wf.id}): cron \`${wf.schedule!.cron}\`${wf.schedule!.timezone ? ` (${wf.schedule!.timezone})` : ''}`);
    }
    lines.push('');
  }

  if (activeTasks.length === 0 && scheduledWorkflows.length === 0) {
    lines.push('No active scheduled tasks or workflow schedules.\n');
  }

  return lines.join('\n');
}

// ── Skill scanner ────────────────────────────────────────────────────

interface SkillInfo {
  name: string;
  description: string;
}

function scanSkills(skillsDir: string): SkillInfo[] {
  const skills: SkillInfo[] = [];

  if (!fs.existsSync(skillsDir)) return skills;

  for (const dir of fs.readdirSync(skillsDir)) {
    const skillMd = path.join(skillsDir, dir, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;

    try {
      const content = fs.readFileSync(skillMd, 'utf-8');
      // Parse YAML frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;

      const fm = fmMatch[1];
      const nameMatch = fm.match(/^name:\s*(.+)$/m);
      const descMatch = fm.match(/^description:\s*(.+)$/m);

      if (nameMatch) {
        skills.push({
          name: nameMatch[1].trim(),
          description: descMatch?.[1]?.trim() || '',
        });
      }
    } catch {
      // Skip malformed skill files
    }
  }

  return skills;
}

// ── Channel awareness ────────────────────────────────────────────────

function resolveChannelFromJid(jid?: string): string {
  if (!jid) return 'unknown';
  if (jid.startsWith('web:')) return 'web';
  if (jid.startsWith('im:')) return 'imessage';
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.startsWith('cli:')) return 'cli';
  if (jid.startsWith('discord:')) return 'discord';
  if (jid.includes('@g.us') || jid.includes('@s.whatsapp.net')) return 'whatsapp';
  return 'unknown';
}

function generateChannelsMd(deps: ContextFileDeps): string {
  const lines: string[] = ['## Channels\n'];

  const currentChannel = resolveChannelFromJid(deps.chatJid);
  lines.push(`**Current channel:** ${currentChannel} (${deps.chatJid})\n`);

  const chats = deps.getChats?.() ?? [];
  const byChannel = new Map<string, ChatInfo[]>();
  for (const chat of chats) {
    const ch = chat.channel || resolveChannelFromJid(chat.jid);
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch)!.push(chat);
  }

  for (const [channel, chatList] of byChannel) {
    lines.push(`### ${channel}`);
    for (const chat of chatList.slice(0, 10)) {
      lines.push(`- ${chat.name || chat.jid} — \`${chat.jid}\`${chat.is_group ? ' (group)' : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Public API ───────────────────────────────────────────────────────

export function writeContextFiles(
  groupIpcDir: string,
  isMain: boolean,
  deps: ContextFileDeps,
): void {
  const contextDir = path.join(groupIpcDir, 'context');
  fs.mkdirSync(contextDir, { recursive: true });

  try {
    // 00-IDENTITY.md — agent's system prompt (from DB or global template)
    fs.writeFileSync(
      path.join(contextDir, '00-IDENTITY.md'),
      deps.agentIdentity ?? '',
    );

    // 01-SOUL.md — agent's personality (from DB or global template)
    fs.writeFileSync(
      path.join(contextDir, '01-SOUL.md'),
      deps.agentSoul ?? '',
    );

    // 02-USER.md is intentionally empty — agent queries the DB on demand
    fs.writeFileSync(path.join(contextDir, '02-USER.md'), '');

    fs.writeFileSync(
      path.join(contextDir, '03-TOOLS.md'),
      generateToolsMd(deps),
    );

    fs.writeFileSync(
      path.join(contextDir, '04-AGENTS.md'),
      generateAgentsMd(deps.agents),
    );

    fs.writeFileSync(
      path.join(contextDir, '05-HEARTBEAT.md'),
      generateHeartbeatMd(deps.tasks, deps.workflows),
    );

    if (deps.chatJid) {
      fs.writeFileSync(
        path.join(contextDir, '06-CHANNELS.md'),
        generateChannelsMd(deps),
      );
    }
  } catch (err) {
    logger.warn({ err, groupIpcDir }, 'Failed to write context files');
  }
}
