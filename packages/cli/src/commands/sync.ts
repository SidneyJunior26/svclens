import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildGraph, computeImpact, diffGraphs, formatDiff, loadCatalog, type Catalog, type GraphDiff, type GraphJson, type SyncMode } from '@svclens/core';
import { isScanRelevant } from '@svclens/scanners';
import fg from 'fast-glob';
import { extractAt, git, GitError, posix, refExists, repoRoot } from '../git.js';
import { formatDiagnostics } from '../report.js';
import { repoLabel } from '../sources.js';
import { loadAndValidate } from './check.js';
import { runScan, slugify } from './scan.js';

export const SYNC_MODES: SyncMode[] = ['comment', 'pr', 'push'];

export interface SyncOptions {
  /** Repository to scan. Default: the current directory. */
  source?: string;
  /** Default: `sync.mode` in svclens.config.yaml, then `comment`. */
  mode?: string;
  createStubs?: boolean;
  internalDomain?: string[];
  /** Write the markdown report here instead of stdout. */
  out?: string;
  /** `pr` mode: branch to create. Default: `svclens/sync-<repository>`. */
  branch?: string;
  /** Commit message for `pr` and `push`. */
  message?: string;
  /** Set to false to commit without pushing. Default: true. */
  push?: boolean;
  /**
   * Git ref the source branch is compared with, e.g. `origin/main`. When set, the sync is skipped if no file the
   * scanner reads changed since then, and the report separates what this branch changed from what was already
   * missing in the catalog.
   */
  base?: string;
}

/** Folders that are never part of the catalog itself. */
const IGNORED = ['.git', '.svclens', 'node_modules', 'dist'];
const BOT_PREFIX = 'svclens/';

/** The scan prints its progress with console.log; here stdout is reserved for the report. */
async function withLogsOnStderr<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isDirectory(), () => false);
}

/** Credential-free label of the repository's origin remote, when it has one. */
async function originLabel(dir: string): Promise<string | undefined> {
  try {
    return repoLabel(await git(dir, ['remote', 'get-url', 'origin']));
  } catch {
    return undefined;
  }
}

/** Files that differ between the scanned copy and the real catalog, relative to the catalog root. */
async function changedFiles(work: string, root: string): Promise<string[]> {
  const files = await fg('**/*', { cwd: work, dot: true, onlyFiles: true, ignore: IGNORED.map((d) => `**/${d}/**`) });
  const changed: string[] = [];
  for (const rel of files.sort()) {
    const next = await readFile(path.join(work, rel));
    const current = await readFile(path.join(root, rel)).catch(() => null);
    if (!current || !current.equals(next)) changed.push(rel);
  }
  return changed;
}

async function commitIdentity(root: string): Promise<string[]> {
  const get = (key: string) => git(root, ['config', key]).catch(() => '');
  if ((await get('user.name')) && (await get('user.email'))) return [];
  return ['-c', 'user.name=svclens', '-c', 'user.email=svclens@users.noreply.github.com'];
}

/** Pushes the current branch; if the remote moved meanwhile, rebases once and tries again. */
async function pushWithRetry(root: string, args: string[], identity: string[]): Promise<void> {
  try {
    await git(root, ['push', ...args]);
  } catch (err) {
    if (!(err instanceof GitError) || !/rejected|non-fast-forward|fetch first/i.test(err.message)) throw err;
    const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    try {
      await git(root, [...identity, 'pull', '--rebase', '--quiet', 'origin', branch]);
    } catch (rebaseErr) {
      await git(root, ['rebase', '--abort']).catch(() => undefined);
      throw rebaseErr;
    }
    await git(root, ['push', ...args]);
  }
}

/** Scans one repository against the catalog and delivers the result. Returns the process exit code. */
export async function runSync(dir: string, opts: SyncOptions): Promise<number> {
  const root = path.resolve(dir);
  const { catalog, diagnostics } = await loadCatalog(root);
  const loadErrors = diagnostics.filter((d) => d.level === 'error');
  if (loadErrors.length) {
    console.error(formatDiagnostics(loadErrors));
    console.error('sync aborted: fix catalog errors first');
    return 1;
  }

  const mode = opts.mode ?? catalog.config.sync.mode;
  if (!SYNC_MODES.includes(mode as SyncMode)) {
    console.error(`unknown mode "${mode}" (available: ${SYNC_MODES.join(', ')})`);
    return 1;
  }
  const source = path.resolve(opts.source ?? '.');
  if (!(await isDirectory(source))) {
    console.error(`source is not a directory: ${source}`);
    return 1;
  }
  if (source === root) {
    console.error('source is the catalog itself; pass the repository to scan with --source');
    return 1;
  }

  let compare: { ref: string; commit: string } | undefined;
  if (opts.base) {
    const found = await resolveBase(source, opts.base);
    if (typeof found === 'string') {
      console.error(found);
      return 1;
    }
    const relevant = (await changedSince(source, found.commit)).filter(isScanRelevant);
    if (relevant.length === 0) {
      console.error(`no configuration or manifest file changed since ${opts.base}; nothing to sync`);
      return 0;
    }
    console.error(`${relevant.length} relevant file${relevant.length === 1 ? '' : 's'} changed since ${opts.base}`);
    compare = { ref: opts.base, commit: found.commit };
  }

  const temps: string[] = [];
  try {
    const repo = await originLabel(source);
    const head = await scanCopy(root, source, opts, repo, temps);
    if (typeof head === 'number') return head;

    const before = buildGraph(catalog, new Date(0));
    const after = buildGraph(head.catalog, new Date(0));
    let report = fullReport(diffGraphs(before, after), after);
    if (compare) {
      const atBase = await baseGraph(root, source, compare.commit, opts, repo, temps);
      if (atBase) report = splitReport(compare.ref, diffGraphs(atBase, after), diffGraphs(before, atBase), after);
      else console.error(`could not scan ${compare.ref}; the report does not separate the changes of this branch`);
    }
    if (opts.out) await writeFile(path.resolve(opts.out), `${report}\n`);
    else console.log(report);

    const changed = await changedFiles(head.work, root);
    if (mode === 'comment') {
      console.error(`mode comment: nothing written to the catalog (${changed.length} file${changed.length === 1 ? '' : 's'} would change)`);
      return 0;
    }
    if (changed.length === 0) {
      console.error('catalog already up to date, nothing to commit');
      return 0;
    }
    return await deliver(root, head.work, source, changed, mode as 'pr' | 'push', opts);
  } finally {
    for (const t of temps) await rm(t, { recursive: true, force: true });
  }
}

/** Copies the catalog, scans `source` into the copy and validates the result. Returns an exit code on failure. */
async function scanCopy(root: string, source: string, opts: SyncOptions, repo: string | undefined, temps: string[]): Promise<{ work: string; catalog: Catalog } | number> {
  const work = await mkdtemp(path.join(os.tmpdir(), 'svclens-sync-'));
  temps.push(work);
  await cp(root, work, { recursive: true, filter: (src) => !path.relative(root, src).split(path.sep).some((seg) => IGNORED.includes(seg)) });
  const code = await withLogsOnStderr(() => runScan(work, { source: [source], createStubs: opts.createStubs, internalDomain: opts.internalDomain, fetch: false, repo }));
  if (code !== 0) return code;
  const scanned = await loadAndValidate(work);
  if (scanned.errors > 0) {
    console.error(formatDiagnostics(scanned.diagnostics));
    console.error('sync aborted: the scan result has errors');
    return 1;
  }
  return { work, catalog: scanned.catalog };
}

/** The commit where the source branch left `ref`, or an error message. */
async function resolveBase(source: string, ref: string): Promise<{ commit: string } | string> {
  if (!(await repoRoot(source))) return '--base needs the source to be a git repository';
  if (!(await refExists(source, ref))) return `git ref not found: ${ref} (in CI, fetch the full history, e.g. fetch-depth: 0)`;
  try {
    return { commit: await git(source, ['merge-base', ref, 'HEAD']) };
  } catch {
    return `no common history between ${ref} and HEAD (in CI, fetch the full history, e.g. fetch-depth: 0)`;
  }
}

/** Files changed in the source since `commit`: committed, staged, modified and untracked. Relative to the source. */
async function changedSince(source: string, commit: string): Promise<string[]> {
  const lines = (s: string) => s.split('\n').filter(Boolean);
  const committed = lines(await git(source, ['diff', '--name-only', '--relative', commit, 'HEAD']));
  const working = lines(await git(source, ['diff', '--name-only', '--relative', 'HEAD']));
  const untracked = lines(await git(source, ['ls-files', '--others', '--exclude-standard']));
  return [...new Set([...committed, ...working, ...untracked])].sort();
}

/** Graph of the catalog after scanning the source as it was at `commit`, or undefined if that failed. */
async function baseGraph(root: string, source: string, commit: string, opts: SyncOptions, repo: string | undefined, temps: string[]): Promise<GraphJson | undefined> {
  const top = await repoRoot(source);
  if (!top) return undefined;
  const holder = await mkdtemp(path.join(os.tmpdir(), 'svclens-base-'));
  temps.push(holder);
  // realpath: on macOS /tmp and /private/tmp are the same folder seen through a symlink.
  const rel = posix(path.relative(await realpath(top), await realpath(source)));
  // The copy keeps the folder name of the source, which the scan uses to name the service.
  const dest = rel ? holder : path.join(holder, path.basename(source));
  const dir = rel ? path.join(holder, rel) : dest;
  try {
    if (!(await extractAt(top, commit, rel, dest))) await mkdir(dir, { recursive: true });
  } catch {
    return undefined;
  }
  const scanned = await scanCopy(root, dir, opts, repo, temps);
  return typeof scanned === 'number' ? undefined : buildGraph(scanned.catalog, new Date(0));
}

const titled = (title: string, d: GraphDiff): string => {
  const body = formatDiff(d, 'markdown');
  return body.startsWith('### svclens') ? body.replace('### svclens', `### ${title}`) : `### ${title}\n\n${body}`;
};

function fullReport(d: GraphDiff, after: GraphJson): string {
  return [formatDiff(d, 'markdown'), impactSection(d.addedEdges.map((e) => e.target), after)].filter(Boolean).join('\n\n');
}

function splitReport(ref: string, branch: GraphDiff, stale: GraphDiff, after: GraphJson): string {
  const parts = [titled(`svclens: changes from this branch (since ${ref})`, branch), impactSection(branch.addedEdges.map((e) => e.target), after)];
  const staleText = formatDiff(stale, 'markdown');
  if (!staleText.startsWith('No changes')) {
    parts.push(titled('svclens: catalog already out of date', stale), 'Found by the scan but not caused by this branch. The pr and push modes write these too.');
  }
  return parts.filter(Boolean).join('\n\n');
}

function impactSection(targets: string[], graph: ReturnType<typeof buildGraph>): string {
  const lines = [...new Set(targets)].sort().flatMap((id) => {
    const impact = computeImpact(graph, id);
    if (!impact) return [];
    const n = impact.affected.length;
    return [`- \`${id}\`: ${n} service${n === 1 ? '' : 's'} depend${n === 1 ? 's' : ''} on it, directly or not`];
  });
  return lines.length ? ['#### Impact on services that gained a dependent', '', ...lines].join('\n') : '';
}

async function deliver(root: string, work: string, source: string, changed: string[], mode: 'pr' | 'push', opts: SyncOptions): Promise<number> {
  if (!(await repoRoot(root))) {
    console.error(`mode ${mode} needs the catalog to be inside a git repository`);
    return 1;
  }
  if (await git(root, ['status', '--porcelain', '--', '.'])) {
    console.error('the catalog has uncommitted changes; commit or stash them before syncing');
    return 1;
  }
  const base = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = slugify(path.basename(source));
  const branch = opts.branch ?? `${BOT_PREFIX}sync-${name}`;
  const message = opts.message ?? `chore: update service map from ${name}`;

  if (mode === 'pr') {
    try {
      await git(root, ['check-ref-format', '--branch', branch]);
    } catch {
      console.error(`invalid branch name: ${branch}`);
      return 1;
    }
    if (await git(root, ['branch', '--list', branch])) {
      console.error(`branch ${branch} already exists in the catalog; pass another with --branch or delete it`);
      return 1;
    }
    await git(root, ['checkout', '--quiet', '-b', branch]);
  }
  try {
    for (const rel of changed) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await cp(path.join(work, rel), path.join(root, rel));
    }
    await git(root, ['add', '--', ...changed]);
    const identity = await commitIdentity(root);
    await git(root, [...identity, 'commit', '--quiet', '-m', message, '--', ...changed]);
    console.error(`committed ${changed.length} file${changed.length === 1 ? '' : 's'} on ${mode === 'pr' ? branch : base}`);
    if (opts.push === false) return 0;
    if (mode === 'pr') {
      // Branches under svclens/ belong to this tool, so a newer sync may replace an older one that is still open.
      await pushWithRetry(root, ['--quiet', ...(branch.startsWith(BOT_PREFIX) ? ['--force'] : []), '--set-upstream', 'origin', branch], identity);
      console.error(`pushed branch ${branch}; open a pull request from it into ${base}`);
    } else {
      await pushWithRetry(root, ['--quiet', 'origin', 'HEAD'], identity);
      console.error(`pushed to ${base}`);
    }
    return 0;
  } catch (err) {
    console.error(`git: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    if (mode === 'pr') await git(root, ['checkout', '--quiet', base]).catch(() => undefined);
  }
}
