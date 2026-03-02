/**
 * Context Assembler for CamBot Agent Runner
 *
 * Builds a structured <cambot-context> wrapper from all context sources:
 * - CLAUDE.md (identity)
 * - Memory instructions + query-relevant context
 * - Dynamic context files (TOOLS.md, AGENTS.md, HEARTBEAT.md, USER.md, etc.)
 *
 * Replaces the piecemeal concatenation that was previously in index.ts.
 */
import fs from 'fs';
import path from 'path';

export interface ContextSources {
  claudeMd?: string;
  memoryInstructions?: string;
  memoryContext?: string;
  contextDir?: string;
}

export function buildCambotContext(sources: ContextSources): string | undefined {
  const hasContent =
    sources.claudeMd ||
    sources.memoryInstructions ||
    sources.memoryContext ||
    (sources.contextDir && fs.existsSync(sources.contextDir));

  if (!hasContent) return undefined;

  const sections: string[] = [];

  sections.push('<cambot-context>');
  sections.push('# CamBot System Context\n');

  if (sources.claudeMd) {
    sections.push('## Identity\n');
    sections.push(sources.claudeMd);
  }

  if (sources.memoryInstructions || sources.memoryContext) {
    sections.push('\n## Memory\n');
    if (sources.memoryInstructions) sections.push(sources.memoryInstructions);
    if (sources.memoryContext) sections.push('\n' + sources.memoryContext);
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
