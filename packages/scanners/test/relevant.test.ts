import { describe, expect, it } from 'vitest';
import { isScanRelevant } from '../src/index.js';

describe('isScanRelevant', () => {
  it('accepts configuration files, manifests and .NET markers', () => {
    for (const f of ['src/Api/appsettings.Production.json', 'Web.Release.config', 'nlog.config', 'docker-compose.yml', 'openapi.yaml', 'svclens.yaml', 'web/package.json', 'src/Api/Api.csproj', 'Service.svc', 'Legacy.asmx', '.env.example', 'conf/app.properties']) {
      expect(isScanRelevant(f), f).toBe(true);
    }
  });

  it('ignores code, docs, lockfiles, real .env files and build output', () => {
    for (const f of ['src/Api/Program.cs', 'README.md', 'web/src/App.tsx', 'package-lock.json', 'pnpm-lock.yaml', '.env', '.env.production', 'src/Api/bin/Debug/appsettings.json', 'node_modules/x/package.json', 'tsconfig.json']) {
      expect(isScanRelevant(f), f).toBe(false);
    }
  });

  it('accepts Windows separators', () => {
    expect(isScanRelevant('src\\Api\\Web.config')).toBe(true);
    expect(isScanRelevant('src\\Api\\obj\\Web.config')).toBe(false);
  });
});
