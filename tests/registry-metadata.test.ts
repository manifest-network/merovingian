import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { assertRegistryMetadata, assertRegistrySnapshots, registryMetadata } from '../scripts/registry-metadata.js';

test('prepared registry metadata matches the release definition and describes fictional amenities', () => {
  const prepared = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
  assertRegistryMetadata(prepared);
  assert.match(prepared.description, /free fictional/);
  assert.ok(prepared.description.length <= 100);
});

test('registry validation rejects identity, version and description drift', () => {
  for (const changed of [
    { name: 'network.manifest.merovingian/merovingian' },
    { version: '0.0.0-stale' },
    { description: 'A place offering physical cookies.' },
  ]) {
    assert.throws(() => assertRegistryMetadata({ ...registryMetadata(), ...changed }), /server.json has drifted/);
  }
});

function snapshotFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merovingian-registry-evidence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const artifact = 'mcp-registry-0.4.2.json';
  const bytes = '{\n  "version": "0.4.2",\n  "status": "active"\n}\n';
  const snapshotFileSha256 = createHash('sha256').update(bytes).digest('hex');
  const snapshot = { artifact, snapshotFileSha256 };
  const writeIndex = (snapshots: unknown[] = [snapshot]) => writeFileSync(
    join(directory, 'mcp-registry-snapshots.json'), JSON.stringify({ schemaVersion: 1, snapshots }),
  );
  writeFileSync(join(directory, artifact), bytes);
  writeIndex();
  return { directory, artifact, bytes, snapshot, writeIndex };
}

test('registry snapshot validation accepts exact bytes and the committed evidence index', (t) => {
  const { directory } = snapshotFixture(t);
  assert.equal(assertRegistrySnapshots(directory), 1);
  assert.ok(assertRegistrySnapshots() >= 2);
});

test('registry snapshot validation rejects changed content and formatting with a stale hash', (t) => {
  const { directory, artifact, bytes } = snapshotFixture(t);
  for (const changed of [
    bytes.replace('active', 'deleted'),
    `${JSON.stringify(JSON.parse(bytes))}\n`,
    bytes.trimEnd(),
  ]) {
    writeFileSync(join(directory, artifact), changed);
    assert.throws(() => assertRegistrySnapshots(directory), /snapshotFileSha256 differs from exact file bytes/);
  }
});

test('registry snapshot validation rejects paths outside the evidence directory', (t) => {
  const { directory, snapshot, writeIndex } = snapshotFixture(t);
  for (const artifact of [
    '../outside.json', '/tmp/outside.json', 'sub/snapshot.json', 'sub\\snapshot.json',
    'file:///tmp/outside.json', '..', null,
  ]) {
    writeIndex([{ ...snapshot, artifact }]);
    assert.throws(() => assertRegistrySnapshots(directory), /artifact must be a JSON filename directly within docs\/evidence/);
  }
});

test('registry snapshot validation rejects missing files and symlinks', (t) => {
  const { directory, artifact, bytes } = snapshotFixture(t);
  rmSync(join(directory, artifact));
  assert.throws(() => assertRegistrySnapshots(directory), /snapshot must be a readable regular file/);
  const outside = mkdtempSync(join(tmpdir(), 'merovingian-outside-evidence-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, artifact), bytes);
  symlinkSync(join(outside, artifact), join(directory, artifact));
  assert.throws(() => assertRegistrySnapshots(directory), /snapshot must be a readable regular file/);
});

test('registry snapshot validation rejects malformed hashes and incomplete indexes', (t) => {
  const { directory, snapshot, writeIndex } = snapshotFixture(t);
  writeIndex([{ ...snapshot, snapshotFileSha256: 'not-a-digest' }]);
  assert.throws(() => assertRegistrySnapshots(directory), /snapshotFileSha256 must be a lowercase SHA-256 digest/);
  writeIndex([]);
  assert.throws(() => assertRegistrySnapshots(directory), /must list at least one snapshot/);
  writeIndex([snapshot, snapshot]);
  assert.throws(() => assertRegistrySnapshots(directory), /Duplicate registry snapshot artifact/);
});
