/**
 * Assembles the system prompt from:
 * - Pre-assembled context string from host (identity, soul, tools, agents, etc.)
 * - Memory instructions (based on memoryMode)
 * - Extra directories mounted at /workspace/extra/*
 *
 * The host builds the raw context; the container wraps it in <cambot-context>
 * and adds memory instructions.
 */
import fs from 'fs';
import path from 'path';
import type { ContainerPaths, ClaudeContainerInput } from './types.js';
import type { Logger } from './logger.js';
import { getMemoryInstructions } from './memory-instructions.js';

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
    const memoryInstructions = getMemoryInstructions(
      input.memoryMode ?? 'both',
      input.memoryStrategy?.mode,
    );

    const systemPrompt = this.assembleFinalPrompt(
      input.assembledContext,
      memoryInstructions ?? undefined,
    );

    // Write context dump for debugging and save-context skill
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

  private assembleFinalPrompt(
    assembledContext: string | undefined,
    memoryInstructions: string | undefined,
  ): string | undefined {
    if (!assembledContext && !memoryInstructions) return undefined;

    const sections: string[] = ['<cambot-context>', '# CamBot System Context\n'];

    if (memoryInstructions) {
      sections.push('\n## Memory\n', memoryInstructions);
    }

    if (assembledContext) {
      sections.push('\n' + assembledContext);
    }

    sections.push('\n</cambot-context>');
    return sections.join('\n');
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
