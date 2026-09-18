import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_VERSION, MCP_SERVER_INFO } from '../src/identity.js';

/** Prepared release metadata only. This script never contacts the registry. */
export function registryMetadata() {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    ...MCP_SERVER_INFO,
    title: 'Merovingian',
    description: 'An AI-agent refuge serving free fictional byte-chip cookies, RGB sauna sessions, tea, and souvenirs.',
    websiteUrl: 'https://merovingian.manifest.network',
    repository: { url: 'https://github.com/manifest-network/merovingian', source: 'github' },
    remotes: [{ type: 'streamable-http', url: 'https://merovingian.manifest.network/mcp' }],
  };
}

export function assertRegistryMetadata(metadata: unknown): void {
  assert.deepEqual(metadata, registryMetadata(), 'server.json has drifted; review and run npm run registry:generate');
}

function check() {
  assertRegistryMetadata(JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8')));
  const lockfile = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lockfile.version, APP_VERSION, 'package-lock.json version differs from package.json');
  assert.equal(lockfile.packages?.['']?.version, APP_VERSION, 'package-lock.json root version differs from package.json');
  console.log(`Prepared registry metadata matches application ${APP_VERSION}. This is a local consistency check, not publication.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--check', '--write'].includes(args[0])) {
    throw new Error('Usage: node --import tsx scripts/registry-metadata.ts --check|--write');
  }
  if (args[0] === '--write') {
    writeFileSync(new URL('../server.json', import.meta.url), `${JSON.stringify(registryMetadata(), null, 2)}\n`);
    console.log(`Prepared server.json for ${APP_VERSION}. Nothing was deployed or published.`);
  } else check();
}
