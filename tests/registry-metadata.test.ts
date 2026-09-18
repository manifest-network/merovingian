import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertRegistryMetadata, registryMetadata } from '../scripts/registry-metadata.js';

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
