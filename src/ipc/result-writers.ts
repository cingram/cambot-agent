import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from '../groups/group-folder.js';

function writeIpcResult(
  sourceGroup: string,
  subdirectory: string,
  requestId: string,
  result: unknown,
): void {
  const resultDir = path.join(resolveGroupIpcPath(sourceGroup), subdirectory);
  fs.mkdirSync(resultDir, { recursive: true });

  const resultFile = path.join(resultDir, `${requestId}.json`);
  const tempFile = `${resultFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(result, null, 2));
  fs.renameSync(tempFile, resultFile);
}

export function writeDelegationResult(
  sourceGroup: string,
  delegationId: string,
  result: { status: string; result?: string | null; error?: string },
): void {
  writeIpcResult(sourceGroup, 'worker-results', delegationId, result);
}

export function writeWorkflowBuildResult(
  sourceGroup: string,
  requestId: string,
  result: unknown,
): void {
  writeIpcResult(sourceGroup, 'workflow-results', requestId, result);
}

export function writeAgentResult(
  sourceGroup: string,
  requestId: string,
  result: { status: string; result?: string; error?: string },
): void {
  writeIpcResult(sourceGroup, 'agent-results', requestId, result);
}

export function writeEmailResult(
  sourceGroup: string,
  requestId: string,
  result: { status: string; result?: string; error?: string },
): void {
  writeIpcResult(sourceGroup, 'email-results', requestId, result);
}
