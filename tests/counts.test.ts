import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { VisitCounter, VisitCountUnavailable } from '../src/counts.js';

const environment = { network: 'mainnet' as const, chainId: 'manifest-ledger-mainnet' };

test('aggregate counts survive reopening and independent writers without storing visits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'merovingian-counts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'visits.sqlite');
  const first = new VisitCounter(environment, path);
  const since = first.snapshot().since;
  assert.deepEqual(first.snapshot().counts, { 'byte-chip-cookie': '0', 'rgb-sauna': '0', 'null-tea': '0' });
  first.record('byte-chip-cookie');
  const overlappingRelease = new VisitCounter(environment, path);
  overlappingRelease.record('byte-chip-cookie');
  first.record('null-tea');
  overlappingRelease.record('rgb-sauna');
  first.close();
  overlappingRelease.close();
  const restarted = new VisitCounter(environment, path);
  assert.deepEqual(restarted.snapshot(), {
    ...environment, status: 'available', since, storage: 'persistent', total: '4',
    counts: { 'byte-chip-cookie': '2', 'rgb-sauna': '1', 'null-tea': '1' },
  });
  restarted.close();
  const db = new DatabaseSync(path);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name), ['amenity_counts', 'refuge_metadata']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM amenity_counts').get()?.n, 3);
  db.close();
});

test('counter state cannot silently cross networks or reset an unreadable database', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'merovingian-counts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'visits.sqlite');
  const mainnet = new VisitCounter(environment, path);
  mainnet.record('rgb-sauna');
  mainnet.close();
  assert.throws(() => new VisitCounter({ network: 'testnet', chainId: 'manifest-ledger-testnet' }, path), /Cannot open the serving counter/);
  const reopened = new VisitCounter(environment, path);
  assert.equal(reopened.snapshot().counts?.['rgb-sauna'], '1');
  reopened.close();
  const db = new DatabaseSync(path);
  db.exec('DROP TABLE refuge_metadata; CREATE TABLE refuge_metadata (unrecognized TEXT)');
  db.close();
  assert.throws(() => new VisitCounter(environment, path), /Cannot open the serving counter/);
});

test('counter unavailability is explicit and is never presented as zero servings', () => {
  const counter = new VisitCounter(environment);
  counter.record('null-tea');
  counter.close();
  assert.throws(() => counter.record('null-tea'), VisitCountUnavailable);
  assert.deepEqual(counter.snapshot(), { ...environment, status: 'unavailable', since: null, counts: null, total: null, storage: 'memory' });
});

test('large totals retain integer precision and overflow fails without corrupting counts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'merovingian-counts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'visits.sqlite');
  const counter = new VisitCounter(environment, path);
  const db = new DatabaseSync(path);
  db.exec("UPDATE amenity_counts SET served=9007199254740993 WHERE amenity='byte-chip-cookie'");
  counter.record('byte-chip-cookie');
  assert.equal(counter.snapshot().counts?.['byte-chip-cookie'], '9007199254740994');
  db.exec("UPDATE amenity_counts SET served=9223372036854775807 WHERE amenity='null-tea'");
  assert.throws(() => counter.record('null-tea'), VisitCountUnavailable);
  assert.equal(counter.snapshot().counts?.['null-tea'], '9223372036854775807');
  counter.close();
  db.close();
});
