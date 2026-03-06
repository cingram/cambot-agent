import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from '../groups/group-folder.js';

export function writeDelegationResult(
  sourceGroup: string,
  delegationId: string,
  result: { status: string; result?: string | null; error?: string },
): void {
  const resultDir = path.join(resolveGroupIpcPath(sourceGroup), 'worker-results');
  fs.mkdirSync(resultDir, { recursive: true });

  const resultFile = path.join(resultDir, `${delegationId}.json`);
  const tempFile = `${resultFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(result, null, 2));
  fs.renameSync(tempFile, resultFile);
}

export function writeWorkflowBuildResult(
  sourceGroup: string,
  requestId: string,
  result: unknown,
): void {
  const resultDir = path.join(resolveGroupIpcPath(sourceGroup), 'workflow-results');
  fs.mkdirSync(resultDir, { recursive: true });

  const resultFile = path.join(resultDir, `${requestId}.json`);
  const tempFile = `${resultFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(result, null, 2));
  fs.renameSync(tempFile, resultFile);
}

export function writeEmailResult(
  sourceGroup: string,
  requestId: string,
  result: { status: string; result?: string; error?: string },
): void {
  const resultDir = path.join(resolveGroupIpcPath(sourceGroup), 'email-results');
  fs.mkdirSync(resultDir, { recursive: true });

  const resultFile = path.join(resultDir, `${requestId}.json`);
  const tempFile = `${resultFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(result, null, 2));
  fs.renameSync(tempFile, resultFile);
}
