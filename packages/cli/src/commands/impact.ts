import path from 'node:path';
import { buildGraph, computeImpact, formatImpact } from '@svclens/core';
import { formatDiagnostics } from '../report.js';
import { loadAndValidate } from './check.js';

export interface ImpactOptions {
  /** Follow at most this many links away from the service. Default: no limit. */
  depth?: number;
  format: 'text' | 'markdown' | 'json';
  /** Exit with code 1 when more than this many services are affected. */
  maxAffected?: number;
}

/** Prints the blast radius of one service. Returns the process exit code. */
export async function runImpact(dir: string, id: string, opts: ImpactOptions): Promise<number> {
  if (!['text', 'markdown', 'json'].includes(opts.format)) {
    console.error(`unknown format "${opts.format}" (available: text, markdown, json)`);
    return 1;
  }
  if (opts.depth !== undefined && (!Number.isInteger(opts.depth) || opts.depth < 1)) {
    console.error('--depth must be a whole number of 1 or more');
    return 1;
  }
  if (opts.maxAffected !== undefined && (!Number.isInteger(opts.maxAffected) || opts.maxAffected < 0)) {
    console.error('--max-affected must be a whole number of 0 or more');
    return 1;
  }

  const { catalog, diagnostics, errors } = await loadAndValidate(path.resolve(dir));
  if (errors > 0) {
    console.error(formatDiagnostics(diagnostics));
    return 1;
  }
  const graph = buildGraph(catalog, new Date(0));
  const result = computeImpact(graph, id, { depth: opts.depth });
  if (!result) {
    const close = graph.nodes.filter((n) => n.id.includes(id) || id.includes(n.id)).slice(0, 5).map((n) => n.id);
    console.error(`service not found: ${id}${close.length > 0 ? ` (did you mean: ${close.join(', ')}?)` : ''}`);
    return 1;
  }

  console.log(opts.format === 'json' ? JSON.stringify(result, null, 2) : formatImpact(result, opts.format));
  if (opts.maxAffected !== undefined && result.affected.length > opts.maxAffected) {
    console.error(`${result.affected.length} services affected, above the limit of ${opts.maxAffected}`);
    return 1;
  }
  return 0;
}
