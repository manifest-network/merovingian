import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { getAmenities, type AmenityId, type VisitEnvironment } from './amenities.js';
import { API_MESSAGES } from './protocol.js';

export interface VisitCounts extends VisitEnvironment {
  status: 'available' | 'unavailable';
  since: string | null;
  counts: Record<AmenityId, string> | null;
  total: string | null;
  storage: 'persistent' | 'memory';
}

export class VisitCountUnavailable extends Error {
  constructor() { super(API_MESSAGES.counterUnavailable); this.name = 'VisitCountUnavailable'; }
}

/** Why the counter could not be opened: another network's data, or unusable storage. */
export type CounterFault = 'identity' | 'storage';
export type CounterEvent = { event: 'counter_unavailable'; reason: CounterFault } | { event: 'counter_recovered' };
export interface VisitCounterOptions { retryMs?: number; now?: () => number; log?: (event: CounterEvent) => void }

class CounterIdentityMismatch extends Error {}

interface CounterStore { db: DatabaseSync; increment: StatementSync; totals: StatementSync; since: string }

function openStore(environment: VisitEnvironment, path: string): CounterStore {
  let db: DatabaseSync | undefined;
  try {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(path, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    // SQLite serializes simultaneous writers, including overlapping releases.
    // A visit is counted durably before its successful response is returned.
    db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    db.exec(`
      CREATE TABLE IF NOT EXISTS refuge_metadata (
        id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL CHECK (version=1),
        network TEXT NOT NULL, chain_id TEXT NOT NULL, since TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS amenity_counts (
        amenity TEXT PRIMARY KEY CHECK (amenity IN ('byte-chip-cookie','rgb-sauna','null-tea')),
        served INTEGER NOT NULL CHECK (served >= 0)
      ) STRICT;
    `);
    db.prepare('INSERT OR IGNORE INTO refuge_metadata VALUES (1,1,?,?,?)')
      .run(environment.network, environment.chainId, new Date().toISOString());
    const metadata = db.prepare('SELECT * FROM refuge_metadata WHERE id=1').get();
    if (!metadata || metadata.version !== 1 || metadata.network !== environment.network
      || metadata.chain_id !== environment.chainId || typeof metadata.since !== 'string'
      || !Number.isFinite(Date.parse(metadata.since))) throw new CounterIdentityMismatch();
    for (const amenity of getAmenities()) {
      db.prepare('INSERT OR IGNORE INTO amenity_counts VALUES (?,0)').run(amenity.id);
    }
    db.exec('COMMIT');
    const increment = db.prepare('UPDATE amenity_counts SET served=served+1 WHERE amenity=? AND served<9223372036854775807');
    const totals = db.prepare('SELECT amenity, served FROM amenity_counts');
    totals.setReadBigInts(true);
    return { db, increment, totals, since: metadata.since };
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch { /* Transaction may not have started. */ }
    try { db?.close(); } catch { /* The database may not have opened. */ }
    throw error instanceof CounterIdentityMismatch ? error : new Error('Cannot open the serving counter.');
  }
}

/**
 * Only three aggregate totals and their start date; never visitor data.
 *
 * Opening never throws. Fred v0.13 closes a lease on chain after its third
 * container exit, and every re-provision reuses the same volume, so exiting on
 * a storage fault would close the lease within minutes. An unopened counter
 * instead serves 503 on visits and reports itself unavailable; persistent
 * storage is retried at most once per retry interval. Every attempt repeats the
 * network-identity check, so another network's data is never counted into.
 */
export class VisitCounter {
  private readonly environment: VisitEnvironment;
  private readonly path: string;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly log: (event: CounterEvent) => void;
  private store: CounterStore | null = null;
  private retryAt = 0;
  private closed = false;
  readonly storage: 'persistent' | 'memory';
  /** Why the counter is unavailable, or null while it is open. */
  fault: CounterFault | null = null;

  constructor(environment: VisitEnvironment, path = ':memory:', options: VisitCounterOptions = {}) {
    this.environment = { network: environment.network, chainId: environment.chainId };
    this.path = path;
    this.storage = path === ':memory:' ? 'memory' : 'persistent';
    this.retryMs = options.retryMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (event => (event.event === 'counter_recovered' ? console.log : console.error)(JSON.stringify(event)));
    this.open();
  }

  private open(): CounterStore | null {
    if (this.store || this.closed) return this.store;
    // Reopening memory storage would silently reset its counts.
    if (this.fault && (this.storage === 'memory' || this.now() < this.retryAt)) return null;
    try {
      this.store = openStore(this.environment, this.path);
      if (this.fault) this.log({ event: 'counter_recovered' });
      this.fault = null;
    } catch (error) {
      const fault: CounterFault = error instanceof CounterIdentityMismatch ? 'identity' : 'storage';
      if (!this.fault) this.log({ event: 'counter_unavailable', reason: fault });
      this.fault = fault;
      this.retryAt = this.now() + this.retryMs;
    }
    return this.store;
  }

  record(amenity: AmenityId): void {
    const store = this.open();
    if (!store) throw new VisitCountUnavailable();
    try {
      if (store.increment.run(amenity).changes !== 1) throw new Error('Counter not incremented');
    } catch { throw new VisitCountUnavailable(); }
  }

  snapshot(): VisitCounts {
    const unavailable: VisitCounts = { ...this.environment, status: 'unavailable', since: null, counts: null, total: null, storage: this.storage };
    const store = this.open();
    if (!store) return unavailable;
    try {
      const rows = store.totals.all();
      const counts = {} as Record<AmenityId, string>;
      let total = 0n;
      for (const amenity of getAmenities()) {
        const value = rows.find(row => row.amenity === amenity.id)?.served;
        if (typeof value !== 'bigint' || value < 0n) throw new Error('Invalid counter');
        counts[amenity.id] = value.toString();
        total += value;
      }
      return { ...this.environment, status: 'available', since: store.since, counts, total: total.toString(), storage: this.storage };
    } catch {
      return unavailable;
    }
  }

  close(): void {
    this.closed = true;
    this.store?.db.close();
    this.store = null;
  }
}
