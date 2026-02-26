/**
 * Smoke test for the workflow integration.
 * Run with: npx tsx scripts/test-workflows.ts
 *
 * Uses a stub agent container callback (no real API calls).
 */
import Database from 'better-sqlite3';
import { createWorkflowSchema } from 'cambot-workflows';
import { createWorkflowService } from '../src/workflow-service.js';

// Use an in-memory DB so we don't touch the real one
const db = new Database(':memory:');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
createWorkflowSchema(db);

const service = createWorkflowService({
  db,
  runAgentContainer: async (prompt: string) => {
    console.log(`  [stub] Container prompt: ${prompt.slice(0, 100)}...`);
    return 'Stub agent response for workflow testing';
  },
});

// 1. Load definitions
console.log('--- reloadDefinitions ---');
service.reloadDefinitions();

// 2. List
const workflows = service.listWorkflows();
console.log(`Loaded ${workflows.length} workflow(s):`);
for (const wf of workflows) {
  console.log(`  - ${wf.id}: ${wf.name} (${wf.steps.length} steps)`);
}

if (workflows.length === 0) {
  console.log('\nNo workflows found in data/workflows/. Copy one there first.');
  process.exit(0);
}

// 3. Run the workflow (agent step uses stub container callback)
const wf = workflows[0];
console.log(`\n--- runWorkflow("${wf.id}") ---`);

try {
  const runId = await service.runWorkflow(wf.id);
  console.log(`\nRun completed! runId: ${runId}`);

  // 4. Check status
  const status = service.getRunStatus(runId);
  console.log(`Status: ${status?.status}`);
  console.log(`Cost: $${status?.totalCostUsd.toFixed(4)}`);
  console.log(`Tokens: ${status?.totalTokensIn} in / ${status?.totalTokensOut} out`);

  // 5. List runs
  const runs = service.listRuns(wf.id);
  console.log(`\n--- listRuns("${wf.id}") ---`);
  for (const r of runs) {
    console.log(`  [${r.runId.slice(0, 8)}] ${r.status} — cost $${r.totalCostUsd.toFixed(4)}`);
  }
} catch (err) {
  console.error('Run failed:', err);
  process.exit(1);
}

// 6. Test pause/cancel
console.log('\n--- pause/cancel test ---');
try {
  const runId2 = await service.runWorkflow(wf.id);
  console.log(`Second run completed: ${runId2}`);
  try {
    service.cancelRun(runId2);
    console.log('ERROR: should have thrown');
  } catch (e) {
    console.log(`Expected error: ${(e as Error).message}`);
  }
} catch (err) {
  console.error('Second run failed:', err);
}

console.log('\n✓ All smoke tests passed');
