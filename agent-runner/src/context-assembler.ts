/**
 * Context Assembler for CamBot Agent Runner
 *
 * Builds a structured <cambot-context> wrapper from all context sources:
 * - CLAUDE.md (identity)
 * - Memory instructions (DB schema + query examples)
 * - Dynamic context files (TOOLS.md, AGENTS.md, HEARTBEAT.md, etc.)
 *
 * Replaces the piecemeal concatenation that was previously in index.ts.
 */
import fs from 'fs';
import path from 'path';

export interface ContextSources {
  claudeMd?: string;
  memoryInstructions?: string;
  contextDir?: string;
}

export function buildCambotContext(sources: ContextSources): string | undefined {
  const hasContent =
    sources.claudeMd ||
    sources.memoryInstructions ||
    (sources.contextDir && fs.existsSync(sources.contextDir));

  if (!hasContent) return undefined;

  const sections: string[] = [];

  sections.push('<cambot-context>');
  sections.push('# CamBot System Context\n');

  if (sources.claudeMd) {
    sections.push('## Identity\n');
    sections.push(sources.claudeMd);
  }

  if (sources.memoryInstructions) {
    sections.push('\n## Memory\n');
    sections.push(sources.memoryInstructions);
  }

  if (sources.contextDir && fs.existsSync(sources.contextDir)) {
    const files = fs.readdirSync(sources.contextDir)
      .filter(f => f.endsWith('.md'))
      .sort();

    for (const file of files) {
      const content = fs.readFileSync(path.join(sources.contextDir, file), 'utf-8').trim();
      if (content) {
        sections.push('\n' + content);
      }
    }
  }

  sections.push('\n</cambot-context>');
  return sections.join('\n');
}
