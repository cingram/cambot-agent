/**
 * Tool Policy — resolves per-group/agent SDK tool restrictions.
 *
 * Policies are stored in the database (never mounted into containers)
 * so agents cannot modify their own tool access.
 */

export const ALL_SDK_TOOLS = [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
] as const;

export type SdkTool = (typeof ALL_SDK_TOOLS)[number];

export type ToolPreset = 'full' | 'standard' | 'readonly' | 'minimal' | 'sandboxed';

const TOOL_PRESETS: Record<ToolPreset, readonly string[]> = {
  full: ALL_SDK_TOOLS,
  standard: ALL_SDK_TOOLS.filter(
    t => !['TeamCreate', 'TeamDelete', 'SendMessage', 'NotebookEdit'].includes(t),
  ),
  readonly: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch', 'Skill'],
  minimal: ['Read', 'Glob', 'Grep'],
  sandboxed: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'ToolSearch', 'Skill'],
};

export interface ToolPolicy {
  preset?: ToolPreset;
  allow?: string[];
  deny?: string[];
  add?: string[];
}

/**
 * Resolve a ToolPolicy to a flat list of SDK tool names.
 * No policy = no SDK tools (least privilege by default).
 */
export function resolveToolList(policy?: ToolPolicy): string[] {
  if (!policy) return [];

  // Explicit allowlist takes priority
  if (policy.allow) return [...policy.allow];

  // Start from preset (default: full)
  const preset = policy.preset ?? 'full';
  const base = TOOL_PRESETS[preset];
  if (!base) {
    throw new Error(`Unknown tool preset: ${preset}`);
  }

  let tools = [...base];

  if (policy.deny) {
    const denySet = new Set(policy.deny);
    tools = tools.filter(t => !denySet.has(t));
  }

  if (policy.add) {
    const existing = new Set(tools);
    for (const t of policy.add) {
      if (!existing.has(t)) tools.push(t);
    }
  }

  return tools;
}
