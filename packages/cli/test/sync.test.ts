import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSync } from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('../../scanners/test/fixtures/repos/orders-api', import.meta.url));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const exists = (p: string) => stat(p).then(() => true, () => false);
const tmp = (prefix: string) => mkdtemp(path.join(os.tmpdir(), `svclens-sync-${prefix}-`));

const SEED: Record<string, string> = {
  'svclens.config.yaml': 'name: Acme\n',
  'services/payments.yaml': 'id: payments-api\nname: Payments\nkind: core\nowner: t\nhosts: [payments.acme.internal]\n',
  'services/inventory.yaml': 'id: inventory-api\nname: Inventory\nkind: core\nowner: t\nhosts: [inventory.acme.internal]\n',
};

/** A bare "remote" with a main branch and a working clone of it that holds the catalog. */
async function setup(files: Record<string, string> = SEED) {
  const remote = await tmp('remote');
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  const seedDir = await tmp('seed');
  git(seedDir, 'init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(seedDir, rel)), { recursive: true });
    await writeFile(path.join(seedDir, rel), text);
  }
  git(seedDir, 'add', '.');
  git(seedDir, 'commit', '-q', '-m', 'seed');
  git(seedDir, 'push', '-q', remote, 'main');
  const clone = async () => {
    const dir = await tmp('clone');
    git(dir, 'clone', '-q', remote, '.');
    return dir;
  };
  return { remote, clone, catalog: await clone() };
}

/** A copy of the scanned fixture, named like the repository it stands for. */
async function source(origin?: string) {
  const dir = path.join(await tmp('src'), 'orders-api');
  await cp(FIXTURE, dir, { recursive: true });
  if (origin) {
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', origin);
  }
  return dir;
}

let out: string[];
let err: string[];
beforeEach(() => {
  // CI runners have no git identity; the tool must work without one.
  vi.stubEnv('GIT_CONFIG_GLOBAL', os.devNull);
  vi.stubEnv('GIT_CONFIG_SYSTEM', os.devNull);
  // Without this git guesses an identity from the user and host name, which a bare CI runner cannot do.
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'user.useConfigOnly');
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
});

afterEach(() => vi.unstubAllEnvs());

describe('runSync comment mode', () => {
  it('reports what would change and writes nothing', async () => {
    const { catalog } = await setup();
    expect(await runSync(catalog, { source: await source() })).toBe(0);
    const report = out.join('\n');
    expect(report).toContain('#### Services added');
    expect(report).toContain('- `orders-api`');
    expect(report).toContain('`orders-api` → `payments-api` (http, confirmed)');
    expect(report).toContain('#### Impact on services that gained a dependent');
    expect(report).toContain('- `payments-api`: 1 service depends on it, directly or not');
    expect(await exists(path.join(catalog, 'services/orders-api.yaml'))).toBe(false);
    expect(git(catalog, 'status', '--porcelain')).toBe('');
  });

  it('keeps stdout for the report and can write it to a file', async () => {
    const { catalog } = await setup();
    const file = path.join(await tmp('out'), 'report.md');
    expect(await runSync(catalog, { source: await source(), out: file })).toBe(0);
    expect(out).toEqual([]);
    expect(await readFile(file, 'utf8')).toContain('#### Links added');
    expect(err.join('\n')).toContain('mode comment: nothing written');
  });

  it('says there is nothing to do when the catalog already matches', async () => {
    const { catalog } = await setup();
    const src = await source();
    expect(await runSync(catalog, { source: src, mode: 'push', push: false })).toBe(0);
    out.length = 0;
    expect(await runSync(catalog, { source: src, mode: 'comment' })).toBe(0);
    expect(out.join('\n')).toContain('No changes in services or links.');
  });
});

describe('runSync push mode', () => {
  it('commits to the catalog branch and pushes it', async () => {
    const { catalog, remote } = await setup();
    expect(await runSync(catalog, { source: await source(), mode: 'push' })).toBe(0);
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('chore: update service map from orders-api');
    expect(git(remote, 'show', 'main:services/orders-api.yaml')).toContain('target: payments-api');
  });

  it('does not commit again when nothing changed', async () => {
    const { catalog, remote } = await setup();
    const src = await source();
    await runSync(catalog, { source: src, mode: 'push' });
    const head = git(remote, 'rev-parse', 'main');
    err.length = 0;
    expect(await runSync(catalog, { source: src, mode: 'push' })).toBe(0);
    expect(git(remote, 'rev-parse', 'main')).toBe(head);
    expect(err.join('\n')).toContain('already up to date');
  });

  it('uses sync.mode from the config when --mode is not given', async () => {
    const { catalog, remote } = await setup({ ...SEED, 'svclens.config.yaml': 'name: Acme\nsync:\n  mode: push\n' });
    expect(await runSync(catalog, { source: await source() })).toBe(0);
    expect(git(remote, 'ls-tree', '--name-only', 'main', 'services/')).toContain('services/orders-api.yaml');
  });

  it('commits locally only with push disabled', async () => {
    const { catalog, remote } = await setup();
    const before = git(remote, 'rev-parse', 'main');
    expect(await runSync(catalog, { source: await source(), mode: 'push', push: false, message: 'chore: mapa' })).toBe(0);
    expect(git(catalog, 'log', '-1', '--format=%s')).toBe('chore: mapa');
    expect(git(remote, 'rev-parse', 'main')).toBe(before);
  });

  it('rebases and pushes again when the remote moved in the meantime', async () => {
    const { catalog, remote, clone } = await setup();
    const other = await clone();
    await writeFile(path.join(other, 'services/billing.yaml'), 'id: billing-api\nname: Billing\nkind: core\nowner: t\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'billing');
    git(other, 'push', '-q', 'origin', 'main');

    expect(await runSync(catalog, { source: await source(), mode: 'push' })).toBe(0);
    const tree = git(remote, 'ls-tree', '--name-only', 'main', 'services/');
    expect(tree).toContain('services/billing.yaml');
    expect(tree).toContain('services/orders-api.yaml');
  });

  it('refuses to run over uncommitted changes in the catalog', async () => {
    const { catalog } = await setup();
    await writeFile(path.join(catalog, 'services/payments.yaml'), 'id: payments-api\nname: Changed\nkind: core\nowner: t\nhosts: [payments.acme.internal]\n');
    expect(await runSync(catalog, { source: await source(), mode: 'push' })).toBe(1);
    expect(err.join('\n')).toContain('uncommitted changes');
  });

  it('keeps tokens from the origin URL out of the catalog', async () => {
    const { catalog } = await setup();
    const src = await source('https://x-access-token:ghs_SECRET123@github.com/acme/orders-api.git');
    expect(await runSync(catalog, { source: src, mode: 'push', push: false })).toBe(0);
    const written = await readFile(path.join(catalog, 'services/orders-api.yaml'), 'utf8');
    expect(written).toContain('repo: github.com/acme/orders-api');
    expect(written + out.join('') + err.join('')).not.toContain('SECRET123');
  });
});

describe('runSync pr mode', () => {
  it('pushes a branch and leaves the catalog branch untouched', async () => {
    const { catalog, remote } = await setup();
    const main = git(remote, 'rev-parse', 'main');
    expect(await runSync(catalog, { source: await source(), mode: 'pr' })).toBe(0);
    expect(git(remote, 'rev-parse', 'main')).toBe(main);
    expect(git(remote, 'show', 'svclens/sync-orders-api:services/orders-api.yaml')).toContain('target: payments-api');
    expect(git(catalog, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(await exists(path.join(catalog, 'services/orders-api.yaml'))).toBe(false);
    expect(err.join('\n')).toContain('open a pull request from it into main');
  });

  it('replaces the bot branch of an earlier sync that is still open', async () => {
    const { catalog, remote, clone } = await setup();
    await runSync(catalog, { source: await source(), mode: 'pr' });
    const first = git(remote, 'rev-parse', 'svclens/sync-orders-api');
    const other = await clone();
    await writeFile(path.join(other, 'services/billing.yaml'), 'id: billing-api\nname: Billing\nkind: core\nowner: t\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'billing');
    git(other, 'push', '-q', 'origin', 'main');
    const again = await clone();
    expect(await runSync(again, { source: await source(), mode: 'pr' })).toBe(0);
    expect(git(remote, 'rev-parse', 'svclens/sync-orders-api')).not.toBe(first);
  });

  it('refuses a branch name that already exists locally', async () => {
    const { catalog } = await setup();
    git(catalog, 'branch', 'svclens/sync-orders-api');
    expect(await runSync(catalog, { source: await source(), mode: 'pr' })).toBe(1);
    expect(err.join('\n')).toContain('already exists');
  });

  it('accepts a custom branch and a custom commit message', async () => {
    const { catalog, remote } = await setup();
    expect(await runSync(catalog, { source: await source(), mode: 'pr', branch: 'mapa/orders', message: 'chore: mapa' })).toBe(0);
    expect(git(remote, 'log', '-1', '--format=%s', 'mapa/orders')).toBe('chore: mapa');
  });
});

describe('runSync input checks', () => {
  it('rejects unknown modes, missing sources and the catalog as its own source', async () => {
    const { catalog } = await setup();
    expect(await runSync(catalog, { source: await source(), mode: 'auto' })).toBe(1);
    expect(await runSync(catalog, { source: path.join(catalog, 'nope') })).toBe(1);
    expect(await runSync(catalog, { source: catalog })).toBe(1);
  });

  it('needs the catalog to be a git repository for pr and push', async () => {
    const plain = await tmp('plain');
    for (const [rel, text] of Object.entries(SEED)) {
      await mkdir(path.dirname(path.join(plain, rel)), { recursive: true });
      await writeFile(path.join(plain, rel), text);
    }
    expect(await runSync(plain, { source: await source(), mode: 'push' })).toBe(1);
    expect(err.join('\n')).toContain('git repository');
    await rm(plain, { recursive: true, force: true });
  });
});
