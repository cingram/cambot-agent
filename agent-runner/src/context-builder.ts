/**
 * Assembles the system prompt from all context sources:
 * - Global CLAUDE.md (for non-main groups)
 * - Memory instructions (based on memoryMode)
 * - Dynamic context files in /workspace/ipc/context/
 * - Extra directories mounted at /workspace/extra/*
 */
import fs from 'fs';
import path from 'path';
import type { ContainerPaths, ClaudeContainerInput } from './types.js';
import type { Logger } from './logger.js';
import { getMemoryInstructions } from './memory-instructions.js';
import { buildCambotContext } from './context-assembler.js';

export interface ContextResult {
  systemPrompt: string | undefined;
  additionalDirectories: string[];
}

export class ContextBuilder {
  constructor(
    private readonly paths: ContainerPaths,
    private readonly logger: Logger,
  ) {}

  build(input: ClaudeContainerInput): ContextResult {
    const claudeMd = !input.isMain && fs.existsSync(this.paths.globalClaudeMdPath)
      ? fs.readFileSync(this.paths.globalClaudeMdPath, 'utf-8')
      : undefined;

    const memoryInstructions = getMemoryInstructions(input.memoryMode ?? 'both');

    const systemPrompt = buildCambotContext({
      claudeMd,
      memoryInstructions: memoryInstructions ?? undefined,
      contextDir: this.paths.contextDir,
    });

    // Write context dump for debugging (host reads from IPC dir)
    if (systemPrompt) {
      try {
        fs.writeFileSync(this.paths.contextDumpFile, systemPrompt);
      } catch (err: unknown) {
        this.logger.log(`Failed to write context dump: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const additionalDirectories = this.discoverExtraDirectories();
    if (additionalDirectories.length > 0) {
      this.logger.log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }

    return { systemPrompt, additionalDirectories };
  }

  private discoverExtraDirectories(): string[] {
    const dirs: string[] = [];
    if (!fs.existsSync(this.paths.extraMountsDir)) return dirs;

    for (const entry of fs.readdirSync(this.paths.extraMountsDir)) {
      const fullPath = path.join(this.paths.extraMountsDir, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        dirs.push(fullPath);
      }
    }
    return dirs;
  }
}
