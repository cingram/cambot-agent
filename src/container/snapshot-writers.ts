import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from '../groups/group-folder.js';
import { WorkerDefinition } from '../types.js';

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export function writeArchivedTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const archivedFile = path.join(groupIpcDir, 'archived_tasks.json');
  fs.writeFileSync(archivedFile, JSON.stringify(filteredTasks, null, 2));
}

/** Shape of a workflow summary entry in the index file. */
export interface WorkflowSnapshotSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  stepCount: number;
  schedule?: { cron: string; timezone?: string };
  hash: string;
}

/** Shape of a full workflow snapshot written per-file. */
export interface WorkflowSnapshotFull {
  id: string;
  name: string;
  description: string;
  version: string;
  hash: string;
  schedule?: { cron: string; timezone?: string };
  steps: Array<{ id: string; type: string; name: string; config: Record<string, unknown>; after?: string[] }>;
  policy: Record<string, unknown>;
}

/**
 * Write per-workflow snapshot files for the container.
 *
 * Layout:
 *   {ipcDir}/workflows/index.json   — lightweight summary array
 *   {ipcDir}/workflows/{id}.json    — full workflow definition (one per workflow)
 *   {ipcDir}/workflow_runs.json     — recent run history (main only)
 *
 * Only rewrites individual {id}.json files when the hash has changed.
 * Cleans up stale files for workflows that no longer exist.
 */
export function writeWorkflowsSnapshot(
  groupFolder: string,
  isMain: boolean,
  workflows: WorkflowSnapshotFull[],
  runs: Array<{
    runId: string;
    workflowId: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    error: string | null;
    totalCostUsd: number;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  const workflowsDir = path.join(groupIpcDir, 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });

  // Build summaries for the index
  const summaries: WorkflowSnapshotSummary[] = workflows.map(wf => ({
    id: wf.id,
    name: wf.name,
    description: wf.description,
    version: wf.version,
    stepCount: wf.steps.length,
    schedule: wf.schedule,
    hash: wf.hash,
  }));

  // Always rewrite the lightweight index (small file)
  fs.writeFileSync(
    path.join(workflowsDir, 'index.json'),
    JSON.stringify(summaries, null, 2),
  );

  // Write per-workflow files, skipping unchanged hashes
  const activeIds = new Set<string>();
  for (const wf of workflows) {
    activeIds.add(wf.id);
    const wfFile = path.join(workflowsDir, `${wf.id}.json`);

    // Skip write if existing file has the same hash
    if (fs.existsSync(wfFile)) {
      try {
        const existing = JSON.parse(fs.readFileSync(wfFile, 'utf-8'));
        if (existing.hash === wf.hash) continue;
      } catch {
        // Corrupted file — overwrite
      }
    }

    fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2));
  }

  // Clean up stale workflow files
  for (const file of fs.readdirSync(workflowsDir)) {
    if (file === 'index.json') continue;
    const id = file.replace(/\.json$/, '');
    if (!activeIds.has(id)) {
      fs.unlinkSync(path.join(workflowsDir, file));
    }
  }

  // Only main sees run history (non-main gets empty array)
  const runsFile = path.join(groupIpcDir, 'workflow_runs.json');
  fs.writeFileSync(runsFile, JSON.stringify(isMain ? runs : [], null, 2));
}

/**
 * Write the workflow schema snapshot for the container's workflow-builder MCP.
 */
export function writeWorkflowSchemaSnapshot(
  groupFolder: string,
  schema: Record<string, unknown>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const schemaFile = path.join(groupIpcDir, 'workflow_schema.json');
  fs.writeFileSync(schemaFile, JSON.stringify(schema, null, 2));
}

/**
 * Write custom agents snapshot for the container to read.
 */
export function writeCustomAgentsSnapshot(
  groupFolder: string,
  isMain: boolean,
  agents: Array<{
    id: string;
    name: string;
    description: string;
    provider: string;
    model: string;
    trigger_pattern: string | null;
    group_folder: string;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredAgents = isMain
    ? agents
    : agents.filter((a) => a.group_folder === groupFolder);

  const agentsFile = path.join(groupIpcDir, 'custom_agents.json');
  fs.writeFileSync(agentsFile, JSON.stringify(filteredAgents, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/**
 * Write available workers snapshot for the container to read.
 */
export function writeWorkersSnapshot(
  groupFolder: string,
  workers: WorkerDefinition[],
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const workersFile = path.join(groupIpcDir, 'available_workers.json');
  fs.writeFileSync(workersFile, JSON.stringify(workers, null, 2));
}
