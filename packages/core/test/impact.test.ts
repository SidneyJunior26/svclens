import { describe, expect, it } from 'vitest';
import { buildGraph, computeImpact, formatImpact } from '../src/index.js';
import { makeCatalog } from './helpers.js';

// web -> bff -> orders -> db, admin -> orders, worker -> orders (amqp, inferred), orders -> billing -> orders (cycle)
const catalog = makeCatalog([
  { id: 'web', kind: 'web', owner: 'frontend', dependsOn: [{ target: 'bff' }] },
  { id: 'bff', kind: 'bff', owner: 'frontend', dependsOn: [{ target: 'orders' }] },
  { id: 'admin', kind: 'web', owner: 'backoffice', dependsOn: [{ target: 'orders' }] },
  { id: 'worker', kind: 'worker', owner: 'platform', dependsOn: [{ target: 'orders', protocol: 'amqp', confidence: 'inferred' }] },
  { id: 'orders', kind: 'core', owner: 'sales', dependsOn: [{ target: 'db', protocol: 'sql' }, { target: 'billing' }, { target: 'gateway-x' }] },
  { id: 'billing', kind: 'core', owner: 'finance', dependsOn: [{ target: 'orders' }] },
  { id: 'db', kind: 'database', owner: 'sales' },
  { id: 'lonely', kind: 'core', owner: 'sales' },
]);
const graph = buildGraph(catalog, new Date(0));

describe('computeImpact', () => {
  it('lists everything that depends on a service, level by level', () => {
    const r = computeImpact(graph, 'orders')!;
    expect(r.affected.map((n) => [n.id, n.depth, n.via])).toEqual([
      ['admin', 1, 'orders'],
      ['bff', 1, 'orders'],
      ['billing', 1, 'orders'],
      ['worker', 1, 'orders'],
      ['web', 2, 'bff'],
    ]);
  });

  it('lists what the service needs, including targets missing from the catalog', () => {
    const r = computeImpact(graph, 'orders')!;
    expect(r.dependencies.map((n) => [n.id, n.depth, n.ghost])).toEqual([
      ['billing', 1, false],
      ['db', 1, false],
      ['gateway-x', 1, true],
    ]);
  });

  it('survives cycles and never lists the analyzed service itself', () => {
    const r = computeImpact(graph, 'billing')!;
    expect(r.affected.map((n) => n.id)).not.toContain('billing');
    expect(r.dependencies.map((n) => n.id)).not.toContain('billing');
    expect(r.affected[0]).toMatchObject({ id: 'orders', depth: 1 });
  });

  it('reports protocol and the weakest confidence of each hop', () => {
    const worker = computeImpact(graph, 'orders')!.affected.find((n) => n.id === 'worker')!;
    expect(worker.protocols).toEqual(['amqp']);
    expect(worker.confidence).toBe('inferred');
  });

  it('merges several links between the same pair into one entry', () => {
    const g = buildGraph(makeCatalog([
      { id: 'a', dependsOn: [{ target: 'b' }, { target: 'b', protocol: 'ws', confidence: 'inferred' }] },
      { id: 'b' },
    ]), new Date(0));
    const [only] = computeImpact(g, 'b')!.affected;
    expect(only!.protocols).toEqual(['http', 'ws']);
    expect(only!.confidence).toBe('inferred');
  });

  it('limits the walk with depth', () => {
    const r = computeImpact(graph, 'orders', { depth: 1 })!;
    expect(r.affected.map((n) => n.id)).not.toContain('web');
    expect(r.maxDepth).toBe(1);
  });

  it('collects owners to notify, without the owner of the analyzed service', () => {
    expect(computeImpact(graph, 'orders')!.owners).toEqual(['backoffice', 'finance', 'frontend', 'platform']);
  });

  it('returns empty lists for an isolated service and undefined for an unknown id', () => {
    const r = computeImpact(graph, 'lonely')!;
    expect(r.affected).toEqual([]);
    expect(r.dependencies).toEqual([]);
    expect(computeImpact(graph, 'nope')).toBeUndefined();
  });

  it('can analyze a target that is not in the catalog', () => {
    const r = computeImpact(graph, 'gateway-x')!;
    expect(r.service.ghost).toBe(true);
    expect(r.affected.map((n) => n.id)).toContain('web');
  });
});

describe('formatImpact', () => {
  it('writes a text summary', () => {
    const text = formatImpact(computeImpact(graph, 'orders')!, 'text');
    expect(text).toContain('If orders fails or changes, 5 services are affected across 2 levels.');
    expect(text).toContain('level 2');
    expect(text).toContain('web web (web, http) via bff');
    expect(text).toContain('worker worker (worker, amqp, inferred)');
    expect(text).toContain('gateway-x gateway-x (external, http, not in catalog)');
    expect(text).toContain('Owners to notify: backoffice, finance, frontend, platform');
  });

  it('writes markdown for pull request comments', () => {
    const md = formatImpact(computeImpact(graph, 'orders')!, 'markdown');
    expect(md).toContain('### svclens impact: `orders`');
    expect(md).toContain('#### Affected (depend on it)');
    expect(md).toContain('- `web` web (web, http) via `bff`');
  });

  it('says so when nothing depends on the service', () => {
    expect(formatImpact(computeImpact(graph, 'lonely')!, 'text')).toContain('Nothing depends on lonely.');
  });
});
