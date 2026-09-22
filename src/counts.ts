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

/** Only three aggregate totals and their start date; never visitor data. */
export class VisitCounter {
  private readonly environment: VisitEnvironment;
  private readonly db: DatabaseSync;
  private readonly increment: StatementSync;
  private readonly totals: StatementSync;
  private readonly since: string;
  readonly storage: 'persistent' | 'memory';

  constructor(environment: VisitEnvironment, path = ':memory:') {
    this.environment = { network: environment.network, chainId: environment.chainId };
    this.storage = path === ':memory:' ? 'memory' : 'persistent';
    if (this.storage === 'persistent') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    try {
      // SQLite serializes simultaneous writers, including overlapping releases.
      // A visit is counted durably before its successful response is returned.
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS refuge_metadata (
          id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL CHECK (version=1),
          network TEXT NOT NULL, chain_id TEXT NOT NULL, since TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS amenity_counts (
          amenity TEXT PRIMARY KEY CHECK (amenity IN ('byte-chip-cookie','rgb-sauna','null-tea')),
          served INTEGER NOT NULL CHECK (served >= 0)
        ) STRICT;
      `);
      this.db.prepare('INSERT OR IGNORE INTO refuge_metadata VALUES (1,1,?,?,?)')
        .run(environment.network, environment.chainId, new Date().toISOString());
      const metadata = this.db.prepare('SELECT * FROM refuge_metadata WHERE id=1').get();
      if (!metadata || metadata.version !== 1 || metadata.network !== environment.network
        || metadata.chain_id !== environment.chainId || typeof metadata.since !== 'string'
        || !Number.isFinite(Date.parse(metadata.since))) throw new Error('Counter identity mismatch');
      this.since = metadata.since;
      for (const amenity of getAmenities()) {
        this.db.prepare('INSERT OR IGNORE INTO amenity_counts VALUES (?,0)').run(amenity.id);
      }
      this.db.exec('COMMIT');
      this.increment = this.db.prepare('UPDATE amenity_counts SET served=served+1 WHERE amenity=? AND served<9223372036854775807');
      this.totals = this.db.prepare('SELECT amenity, served FROM amenity_counts');
      this.totals.setReadBigInts(true);
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* Transaction may not have started. */ }
      this.db.close();
      throw new Error('Cannot open the serving counter. Check its storage and network configuration.');
    }
  }

  record(amenity: AmenityId): void {
    try {
      if (this.increment.run(amenity).changes !== 1) throw new Error('Counter not incremented');
    } catch { throw new VisitCountUnavailable(); }
  }

  snapshot(): VisitCounts {
    try {
      const rows = this.totals.all();
      const counts = {} as Record<AmenityId, string>;
      let total = 0n;
      for (const amenity of getAmenities()) {
        const value = rows.find(row => row.amenity === amenity.id)?.served;
        if (typeof value !== 'bigint' || value < 0n) throw new Error('Invalid counter');
        counts[amenity.id] = value.toString();
        total += value;
      }
      return { ...this.environment, status: 'available', since: this.since, counts, total: total.toString(), storage: this.storage };
    } catch {
      return { ...this.environment, status: 'unavailable', since: null, counts: null, total: null, storage: this.storage };
    }
  }

  close(): void { this.db.close(); }
}
