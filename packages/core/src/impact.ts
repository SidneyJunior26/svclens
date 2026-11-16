import type { Confidence } from './schema.js';
import type { GraphJson, GraphNode } from './graph.js';

export interface ImpactNode {
  id: string;
  label: string;
  kind: string;
  owner?: string;
  /** True when the id is a link target that has no service file in the catalog. */
  ghost: boolean;
  /** Number of links between this node and the service being analyzed. */
  depth: number;
  /** The node one level closer to the analyzed service, through which this one was reached. */
  via: string;
  /** Protocols of the links between `via` and this node. */
  protocols: string[];
  /** Weakest confidence among the links between `via` and this node. */
  confidence: Confidence;
}

export interface ImpactResult {
  service: Pick<GraphNode, 'id' | 'label' | 'kind' | 'owner' | 'ghost'>;
  /** Depth limit used, when there was one. */
  maxDepth?: number;
  /** Everything that depends on the service, directly or not: who is hit when it fails or changes. */
  affected: ImpactNode[];
  /** Everything the service depends on, directly or not: what it needs to work. */
  dependencies: ImpactNode[];
  /** Owners of the affected services, sorted, without the owner of the analyzed service. */
  owners: string[];
}

// Only `inferred` is uncertain: `manual` links were declared by a person and `confirmed` ones were verified.
const RANK: Record<Confidence, number> = { confirmed: 0, manual: 1, inferred: 2 };
const weakest = (a: Confidence, b: Confidence): Confidence => (RANK[a] >= RANK[b] ? a : b);

/**
 * Breadth-first walk from `id`. `reverse` follows links from target to source (dependents);
 * otherwise from source to target (dependencies). Cycles are cut by the visited set.
 */
function walk(g: GraphJson, id: string, reverse: boolean, maxDepth?: number): ImpactNode[] {
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const next = new Map<string, Map<string, { protocols: Set<string>; confidence: Confidence }>>();
  for (const e of g.edges) {
    const [from, to] = reverse ? [e.target, e.source] : [e.source, e.target];
    if (!next.has(from)) next.set(from, new Map());
    const neighbors = next.get(from)!;
    const known = neighbors.get(to);
    if (known) {
      known.protocols.add(e.protocol);
      known.confidence = weakest(known.confidence, e.confidence);
    } else {
      neighbors.set(to, { protocols: new Set([e.protocol]), confidence: e.confidence });
    }
  }

  const seen = new Set([id]);
  const out: ImpactNode[] = [];
  let level = [id];
  for (let depth = 1; level.length > 0 && (maxDepth === undefined || depth <= maxDepth); depth++) {
    const following: string[] = [];
    for (const from of level) {
      const neighbors = [...(next.get(from) ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (const [to, link] of neighbors) {
        if (seen.has(to)) continue;
        seen.add(to);
        const n = nodes.get(to)!;
        out.push({
          id: n.id,
          label: n.label,
          kind: n.kind,
          ...(n.owner ? { owner: n.owner } : {}),
          ghost: n.ghost,
          depth,
          via: from,
          protocols: [...link.protocols].sort(),
          confidence: link.confidence,
        });
        following.push(to);
      }
    }
    level = following;
  }
  return out;
}

/** Blast radius of one service. Returns undefined when the id is not in the graph. */
export function computeImpact(g: GraphJson, id: string, opts: { depth?: number } = {}): ImpactResult | undefined {
  const root = g.nodes.find((n) => n.id === id);
  if (!root) return undefined;
  const affected = walk(g, id, true, opts.depth);
  const dependencies = walk(g, id, false, opts.depth);
  const owners = [...new Set(affected.flatMap((n) => (n.owner && n.owner !== root.owner ? [n.owner] : [])))].sort();
  return {
    service: { id: root.id, label: root.label, kind: root.kind, ...(root.owner ? { owner: root.owner } : {}), ghost: root.ghost },
    ...(opts.depth !== undefined ? { maxDepth: opts.depth } : {}),
    affected,
    dependencies,
    owners,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const levels = (list: ImpactNode[]) => list.reduce((max, n) => Math.max(max, n.depth), 0);

/** Human summary of an impact result. Markdown is meant for pull request comments. */
export function formatImpact(r: ImpactResult, format: 'text' | 'markdown'): string {
  const md = format === 'markdown';
  const code = (s: string) => (md ? `\`${s}\`` : s);
  const row = (n: ImpactNode) => {
    const notes = [n.protocols.join(', '), n.confidence === 'inferred' ? 'inferred' : '', n.ghost ? 'not in catalog' : ''].filter(Boolean).join(', ');
    const via = n.depth > 1 ? ` via ${code(n.via)}` : '';
    return `${code(n.id)} ${n.label} (${n.kind}, ${notes})${via}`;
  };
  const section = (title: string, list: ImpactNode[], empty: string): string[] => {
    const lines: string[] = [md ? `#### ${title}` : title];
    if (md) lines.push('');
    if (list.length === 0) {
      lines.push(md ? empty : `  ${empty}`);
      return lines;
    }
    for (let depth = 1; depth <= levels(list); depth++) {
      const items = list.filter((n) => n.depth === depth);
      if (items.length === 0) continue;
      lines.push(md ? `Level ${depth}:` : `  level ${depth}`);
      if (md) lines.push('');
      for (const n of items) lines.push(md ? `- ${row(n)}` : `    ${row(n)}`);
      if (md) lines.push('');
    }
    if (md) lines.pop();
    return lines;
  };

  const limit = r.maxDepth !== undefined ? ` (depth limited to ${r.maxDepth})` : '';
  const headline = r.affected.length === 0
    ? `Nothing depends on ${code(r.service.id)}${limit}.`
    : `If ${code(r.service.id)} fails or changes, ${plural(r.affected.length, 'service is', 'services are')} affected across ${plural(levels(r.affected), 'level', 'levels')}${limit}.`;
  const title = `${r.service.label} (${r.service.kind}${r.service.owner ? `, ${r.service.owner}` : ''})`;
  const out: string[] = [md ? `### svclens impact: ${code(r.service.id)}` : `Impact of ${r.service.id}: ${title}`];
  if (md) out.push('', title);
  out.push('', headline, '');
  out.push(...section('Affected (depend on it)', r.affected, 'None.'), '');
  out.push(...section('Depends on', r.dependencies, 'Nothing.'));
  if (r.owners.length > 0) out.push('', `Owners to notify: ${r.owners.join(', ')}`);
  return out.join('\n');
}
