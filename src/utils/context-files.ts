/**
 * Dynamic Context Generator
 *
 * Assembles agent context (identity, soul, tools, agents, heartbeat, channels)
 * into a single string on the host. The string is passed to the container via
 * stdin as `assembledContext`, where the container wraps it in <cambot-context>
 * and adds memory instructions.
 */
import fs from 'fs';
import path from 'path';

import { SKILLS_DIR } from '../config/config.js';

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
  capabilities: string[];
  mcpServers: string[];
  channels: string[];
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

interface ContextFileDeps {
  mcpServers: McpServerInfo[];
  agents: AgentSummaryRow[];
  tasks: ScheduledTaskRow[];
  workflows: WorkflowSummary[];
  agentIdentity?: string;
  agentSoul?: string;
  chatJid?: string;
  getChats?: () => ChatInfo[];
  /** When set, only list these skill directory names in 03-TOOLS.md.
   *  undefined = all skills (backwards-compatible default). */
  skillsWhitelist?: string[];
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
  lines.push('| save_context | Save full context snapshot to host filesystem |');
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

  // Skills — filter to agent's whitelist when set
  const allSkills = scanSkills(SKILLS_DIR);
  const skills = deps.skillsWhitelist
    ? allSkills.filter(s => deps.skillsWhitelist!.includes(s.id))
    : allSkills;
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
    return '## Agent Registry\n\nNo agents registered.\n';
  }

  const lines: string[] = [
    '## Agent Registry',
    '',
    'Use `send_to_agent` to delegate work to any agent below.',
    '',
  ];

  for (const agent of agents) {
    lines.push(`### ${agent.id}`);
    lines.push(`**${agent.name}** — ${agent.description || 'No description'}`);
    lines.push(`- **Provider:** ${agent.provider} (${agent.model})`);

    if (agent.capabilities.length > 0) {
      lines.push(`- **Capabilities:** ${agent.capabilities.join(', ')}`);
    }
    if (agent.mcpServers.length > 0) {
      lines.push(`- **MCP Servers:** ${agent.mcpServers.join(', ')}`);
    }
    if (agent.channels.length > 0) {
      lines.push(`- **Channels:** ${agent.channels.join(', ')}`);
    }
    lines.push('');
  }

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

export interface SkillInfo {
  /** Directory name — used as the skill identifier */
  id: string;
  name: string;
  description: string;
}

export function scanSkills(skillsDir: string): SkillInfo[] {
  const skills: SkillInfo[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(skillsDir);
  } catch {
    return skills;
  }

  for (const dir of entries) {
    const skillMd = path.join(skillsDir, dir, 'SKILL.md');
    try {
      const content = fs.readFileSync(skillMd, 'utf-8').replace(/\r\n/g, '\n');
      // Parse YAML frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;

      const fm = fmMatch[1];
      const nameMatch = fm.match(/^name:\s*(.+)$/m);
      const descMatch = fm.match(/^description:\s*(.+)$/m);

      if (nameMatch) {
        skills.push({
          id: dir,
          name: nameMatch[1].trim(),
          description: descMatch?.[1]?.trim() || '',
        });
      }
    } catch {
      // Skip missing or malformed skill files
    }
  }

  return skills;
}

// ── Channel awareness ────────────────────────────────────────────────

// Re-export shared utility used by generateChannelsMd
import { channelFromJid as resolveChannelFromJid } from './channel-from-jid.js';

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

/**
 * Assemble all context sections into a single string.
 * This replaces the old writeContextFiles() + container-side assembly pipeline.
 * The host builds the string; the container wraps it in <cambot-context> and
 * adds memory instructions.
 */
export function assembleContextString(deps: ContextFileDeps): string {
  const sections: string[] = [];

  if (deps.agentIdentity) sections.push(deps.agentIdentity);
  if (deps.agentSoul) sections.push(deps.agentSoul);
  // 02-USER is intentionally omitted — agent queries the DB on demand
  sections.push(generateToolsMd(deps));
  sections.push(generateAgentsMd(deps.agents));
  sections.push(generateHeartbeatMd(deps.tasks, deps.workflows));
  if (deps.chatJid) sections.push(generateChannelsMd(deps));

  return sections.filter(s => s.trim()).join('\n\n');
}
