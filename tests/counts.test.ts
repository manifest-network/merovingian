import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { VisitCounter, VisitCountUnavailable, type CounterEvent, type CounterFault } from '../src/counts.js';

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

const quiet = { log: () => {} };
const fileBytes = (path: string) => readFileSync(path).toString('base64');

function assertUnavailable(counter: VisitCounter, fault: CounterFault) {
  assert.equal(counter.fault, fault);
  assert.equal(counter.snapshot().status, 'unavailable');
  assert.deepEqual(counter.snapshot().counts, null);
  assert.throws(() => counter.record('rgb-sauna'), VisitCountUnavailable);
}

test('counter state cannot silently cross networks or reset an unreadable database', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'merovingian-counts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'visits.sqlite');
  const mainnet = new VisitCounter(environment, path);
  mainnet.record('rgb-sauna');
  mainnet.close();
  const before = fileBytes(path);
  const testnet = new VisitCounter({ network: 'testnet', chainId: 'manifest-ledger-testnet' }, path, { ...quiet, retryMs: 0 });
  assertUnavailable(testnet, 'identity');
  assertUnavailable(testnet, 'identity'); // Every retry repeats the identity check.
  testnet.close();
  assert.equal(fileBytes(path), before, 'Another network never writes to this database');
  const reopened = new VisitCounter(environment, path);
  assert.equal(reopened.snapshot().counts?.['rgb-sauna'], '1');
  reopened.close();
  const db = new DatabaseSync(path);
  db.exec('DROP TABLE refuge_metadata; CREATE TABLE refuge_metadata (unrecognized TEXT)');
  db.close();
  const unrecognized = new VisitCounter(environment, path, quiet);
  assertUnavailable(unrecognized, 'storage');
  unrecognized.close();
  const check = new DatabaseSync(path);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM refuge_metadata').get()?.n, 0);
  check.close();
});

test('storage faults leave the process serving, log once and recover without a restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'merovingian-counts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'visits.sqlite');
  writeFileSync(path, randomBytes(4096));
  let now = 0;
  const events: CounterEvent[] = [];
  const counter = new VisitCounter(environment, path, { retryMs: 60_000, now: () => now, log: event => events.push(event) });
  assertUnavailable(counter, 'storage');
  assert.deepEqual(events, [{ event: 'counter_unavailable', reason: 'storage' }], 'Repeated failures log once');
  rmSync(path);
  now = 59_999;
  assertUnavailable(counter, 'storage'); // No reopen before the retry interval, even once storage is repaired.
  now = 60_000;
  counter.record('null-tea');
  assert.equal(counter.fault, null);
  assert.equal(counter.snapshot().counts?.['null-tea'], '1');
  assert.deepEqual(events.at(-1), { event: 'counter_recovered' });
  counter.close();
});

test('unwritable or read-only storage degrades instead of exiting', { skip: process.getuid?.() === 0 && 'root ignores file permissions' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'merovingian-counts-'));
  t.after(async () => { chmodSync(directory, 0o700); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, 'visits.sqlite');
  const seeded = new VisitCounter(environment, path);
  seeded.close();
  // A read-only file fails the first write statement.
  chmodSync(path, 0o444);
  const readOnly = new VisitCounter(environment, path, quiet);
  assertUnavailable(readOnly, 'storage');
  readOnly.close();
  // A writable file in a directory that cannot hold the journal, as on a reused
  // volume, changes no page while opening and fails only the write probe.
  chmodSync(path, 0o600);
  chmodSync(directory, 0o500);
  const events: CounterEvent[] = [];
  const existing = new VisitCounter(environment, path, { log: event => events.push(event) });
  assertUnavailable(existing, 'storage');
  assert.deepEqual(events, [{ event: 'counter_unavailable', reason: 'storage' }]);
  existing.close();
  chmodSync(directory, 0o700);
  const blocked = join(directory, 'blocked');
  mkdirSync(blocked, { mode: 0o500 });
  const unwritable = new VisitCounter(environment, join(blocked, 'visits.sqlite'), quiet);
  assertUnavailable(unwritable, 'storage');
  unwritable.close();
});

test('storage that fails after opening becomes a logged fault and reopens after the retry interval', { skip: process.getuid?.() === 0 && 'root ignores file permissions' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'merovingian-counts-'));
  t.after(async () => { chmodSync(directory, 0o700); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, 'visits.sqlite');
  let now = 0;
  const events: CounterEvent[] = [];
  const counter = new VisitCounter(environment, path, { retryMs: 60_000, now: () => now, log: event => events.push(event) });
  counter.record('rgb-sauna');
  chmodSync(directory, 0o500);
  assert.equal(counter.snapshot().status, 'available', 'Reads alone still work');
  assert.throws(() => counter.record('rgb-sauna'), VisitCountUnavailable);
  assertUnavailable(counter, 'storage');
  assert.deepEqual(events, [{ event: 'counter_unavailable', reason: 'storage' }]);
  chmodSync(directory, 0o700);
  now = 60_000;
  counter.record('rgb-sauna');
  assert.equal(counter.snapshot().counts?.['rgb-sauna'], '2');
  assert.deepEqual(events.at(-1), { event: 'counter_recovered' });
  counter.close();
});

test('counter unavailability is explicit and is never presented as zero servings', () => {
  const counter = new VisitCounter(environment, ':memory:', { retryMs: 0 });
  counter.record('null-tea');
  counter.close();
  // A closed counter never reopens, which for memory storage would reset its counts.
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
