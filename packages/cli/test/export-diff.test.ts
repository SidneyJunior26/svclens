import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runDiff, runExport, runImpact } from '../src/index.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();

async function write(dir: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
}

let out: string[];
beforeEach(() => {
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void out.push(a.join(' ')));
});

describe('runExport', () => {
  it('prints mermaid to stdout or writes a file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'svclens-export-'));
    await write(dir, { 'services/a.yaml': 'id: a\nname: A\nkind: core\nowner: t\ndependsOn:\n  - target: b\n', 'services/b.yaml': 'id: b\nname: B\nkind: database\nowner: t\n' });
    expect(await runExport(dir, { format: 'mermaid' })).toBe(0);
    expect(out.join('\n')).toContain('flowchart LR');
    expect(await runExport(dir, { format: 'mermaid', out: path.join(dir, 'map.mmd') })).toBe(0);
    expect(await readFile(path.join(dir, 'map.mmd'), 'utf8')).toContain('a ==> b');
  });

  it('rejects unknown formats', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'svclens-export-'));
    expect(await runExport(dir, { format: 'svg' })).toBe(1);
  });
});

describe('runDiff', () => {
  it('compares the working tree with a git ref', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'svclens-diff-'));
    git(repo, 'init', '-q', '-b', 'main');
    await write(repo, {
      'catalog/services/a.yaml': 'id: a\nname: A\nkind: core\nowner: t\ndependsOn:\n  - target: b\n',
      'catalog/services/b.yaml': 'id: b\nname: B\nkind: core\nowner: t\n',
    });
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    await write(repo, { 'catalog/services/c.yaml': 'id: c\nname: C\nkind: core\nowner: t\n', 'catalog/services/a.yaml': 'id: a\nname: A\nkind: core\nowner: t\ndependsOn:\n  - target: c\n' });
    await rm(path.join(repo, 'catalog/services/b.yaml'));

    expect(await runDiff(path.join(repo, 'catalog'), { base: 'main', format: 'markdown' })).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('#### Services added');
    expect(text).toContain('- `c` C (core)');
    expect(text).toContain('#### Services removed');
    expect(text).toContain('`a` → `c` (http, manual)');
  });

  it('treats a catalog missing at the base ref as empty', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'svclens-diff-'));
    git(repo, 'init', '-q', '-b', 'main');
    await write(repo, { 'README.md': 'x' });
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    await write(repo, { 'catalog/services/a.yaml': 'id: a\nname: A\nkind: core\nowner: t\n' });
    expect(await runDiff(path.join(repo, 'catalog'), { base: 'main', format: 'text' })).toBe(0);
    expect(out.join('\n')).toContain('Services added:');
  });

  it('fails clearly outside a git repository or with an unknown ref', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'svclens-nogit-'));
    expect(await runDiff(dir, { base: 'main', format: 'text' })).toBe(1);
    expect(out.join('\n')).toContain('not inside a git repository');
  });
});

describe('runDiff with the catalog at the repository root', () => {
  it('reads the base version instead of treating every service as new', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'svclens-diff-root-'));
    git(repo, 'init', '-q', '-b', 'main');
    await write(repo, { 'services/a.yaml': 'id: a\nname: A\nkind: core\nowner: t\n' });
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    await write(repo, { 'services/b.yaml': 'id: b\nname: B\nkind: core\nowner: t\n' });

    expect(await runDiff(repo, { base: 'main', format: 'text' })).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('+1 services');
    expect(text).not.toContain('a A (core)');
  });
});

describe('runImpact', () => {
  const files = {
    'services/web.yaml': 'id: web\nname: Web\nkind: web\nowner: front\ndependsOn:\n  - target: orders\n',
    'services/admin.yaml': 'id: admin\nname: Admin\nkind: web\nowner: back\ndependsOn:\n  - target: orders\n',
    'services/orders.yaml': 'id: orders\nname: Orders\nkind: core\nowner: sales\ndependsOn:\n  - target: db\n    protocol: sql\n',
    'services/db.yaml': 'id: db\nname: DB\nkind: database\nowner: sales\n',
  };
  const setup = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'svclens-impact-'));
    await write(dir, files);
    return dir;
  };

  it('prints who is affected and what the service depends on', async () => {
    const dir = await setup();
    expect(await runImpact(dir, 'orders', { format: 'text' })).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('2 services are affected');
    expect(text).toContain('web Web (web, http)');
    expect(text).toContain('db DB (database, sql)');
    expect(text).toContain('Owners to notify: back, front');
  });

  it('writes json and markdown', async () => {
    const dir = await setup();
    expect(await runImpact(dir, 'db', { format: 'json' })).toBe(0);
    const json = JSON.parse(out.join('\n'));
    expect(json.affected.map((n: { id: string }) => n.id)).toEqual(['orders', 'admin', 'web']);
    out.length = 0;
    expect(await runImpact(dir, 'db', { format: 'markdown', depth: 1 })).toBe(0);
    expect(out.join('\n')).toContain('### svclens impact: `db`');
    expect(out.join('\n')).not.toContain('`web`');
  });

  it('fails above --max-affected and passes at the limit', async () => {
    const dir = await setup();
    expect(await runImpact(dir, 'orders', { format: 'text', maxAffected: 2 })).toBe(0);
    expect(await runImpact(dir, 'orders', { format: 'text', maxAffected: 1 })).toBe(1);
    expect(out.join('\n')).toContain('2 services affected, above the limit of 1');
  });

  it('rejects unknown services with suggestions and invalid options', async () => {
    const dir = await setup();
    expect(await runImpact(dir, 'order', { format: 'text' })).toBe(1);
    expect(out.join('\n')).toContain('service not found: order (did you mean: orders?)');
    expect(await runImpact(dir, 'orders', { format: 'text', depth: 0 })).toBe(1);
    expect(await runImpact(dir, 'orders', { format: 'text', maxAffected: -1 })).toBe(1);
    expect(await runImpact(dir, 'orders', { format: 'xml' as 'text' })).toBe(1);
  });
});
