import path from 'node:path';
import { ALLOWED_ENV_FILES, IGNORED_DIRS, LOCKFILES } from './files.js';
import { isStructuredConfig } from './configs.js';
import { scanText } from './urls.js';
import type { Scanner } from './types.js';

export { NOISE_HOSTS } from './urls.js';

const CONFIG_EXT = new Set(['.json', '.yaml', '.yml', '.xml', '.config', '.properties', '.toml', '.ini', '.conf']);
/** Manifest files whose URLs point to registries, docs or repos, not runtime dependencies. */
const SKIP_FILES = new Set(['package.json', 'composer.json', 'tsconfig.json', 'jsconfig.json']);

export function isConfigFile(rel: string): boolean {
  const base = path.posix.basename(rel);
  if (SKIP_FILES.has(base)) return false;
  return ALLOWED_ENV_FILES.includes(base) || CONFIG_EXT.has(path.posix.extname(base).toLowerCase());
}

/**
 * True when a change to this file can change what the scan finds: configuration files, package and
 * project manifests, and the .svc/.asmx files that mark a .NET web service. Paths are relative to the repository.
 */
export function isScanRelevant(rel: string): boolean {
  const p = rel.split('\\').join('/');
  if (p.split('/').some((seg) => IGNORED_DIRS.includes(seg))) return false;
  const base = path.posix.basename(p);
  if (LOCKFILES.includes(base)) return false;
  if (base === 'package.json' || /\.(csproj|svc|asmx)$/i.test(base)) return true;
  return isConfigFile(p);
}

/** Finds URL-like endpoints in configuration files that the structured scanner does not own. */
export const genericScanner: Scanner = {
  name: 'generic',
  async scan(repo, acc) {
    for (const file of repo.list().filter((f) => isConfigFile(f) && !isStructuredConfig(f))) {
      scanText(await repo.read(file), file, acc);
    }
  },
};
