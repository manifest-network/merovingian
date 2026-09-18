import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/** Check exact historical snapshot bytes without rewriting their contents or index. */
export function assertRegistrySnapshots(
  evidenceDirectory = fileURLToPath(new URL('../docs/evidence/', import.meta.url)),
): number {
  const index: unknown = JSON.parse(readFileSync(join(evidenceDirectory, 'mcp-registry-snapshots.json'), 'utf8'));
  assert.ok(index !== null && typeof index === 'object' && 'schemaVersion' in index && index.schemaVersion === 1,
    'mcp-registry-snapshots.json must use schemaVersion 1');
  assert.ok('snapshots' in index && Array.isArray(index.snapshots) && index.snapshots.length > 0,
    'mcp-registry-snapshots.json must list at least one snapshot');
  const artifacts = new Set<string>();
  for (const snapshot of index.snapshots as unknown[]) {
    assert.ok(snapshot !== null && typeof snapshot === 'object' && 'artifact' in snapshot,
      'Each registry snapshot must name its artifact');
    const { artifact } = snapshot;
    assert.ok(typeof artifact === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(artifact),
      'Registry snapshot artifact must be a JSON filename directly within docs/evidence (no absolute paths or traversal)');
    assert.ok(!artifacts.has(artifact), `Duplicate registry snapshot artifact: ${artifact}`);
    artifacts.add(artifact);
    assert.ok('snapshotFileSha256' in snapshot && typeof snapshot.snapshotFileSha256 === 'string'
      && /^[a-f0-9]{64}$/.test(snapshot.snapshotFileSha256),
    `${artifact}: snapshotFileSha256 must be a lowercase SHA-256 digest`);

    const snapshotPath = join(evidenceDirectory, artifact);
    let bytes: Buffer;
    try {
      // Reject symlinks, including links to files outside the evidence directory.
      assert.ok(lstatSync(snapshotPath).isFile());
      bytes = readFileSync(snapshotPath);
    } catch {
      assert.fail(`${artifact}: snapshot must be a readable regular file in docs/evidence, not a symlink; restore the immutable artifact`);
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, snapshot.snapshotFileSha256,
      `${artifact}: snapshotFileSha256 differs from exact file bytes; restore the immutable snapshot instead of regenerating historical evidence`);
  }
  return artifacts.size;
}

function check() {
  assertRegistryMetadata(JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8')));
  const lockfile = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lockfile.version, APP_VERSION, 'package-lock.json version differs from package.json');
  assert.equal(lockfile.packages?.['']?.version, APP_VERSION, 'package-lock.json root version differs from package.json');
  const snapshotCount = assertRegistrySnapshots();
  console.log(`Prepared registry metadata matches application ${APP_VERSION}. This is a local consistency check, not publication.`);
  console.log(`Verified exact bytes of ${snapshotCount} immutable registry snapshots against their recorded SHA-256 hashes.`);
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
