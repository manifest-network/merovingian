import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Registry } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import { cosmosProtoRegistry, liftedinitProtoRegistry } from '@manifest-network/manifestjs';
import { MsgCreateLease } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/tx.js';
import { DirectSecp256k1HdWallet } from 'cosmjs-proto-signing-modern';
import { AuthInfo, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx.js';
import { MAINNET } from '../scripts/mainnet-config.js';
import { createTransactionJournal, executeJournaledTransaction, reconcileJournaledTransaction, type JournaledTransactionOptions, type TransactionJournal, type TransactionLookup, type TransactionRecord, type TransactionTransport } from '../scripts/mainnet-transactions.js';

const CREATE = '/liftedinit.billing.v1.MsgCreateLease';
const denom = 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr';
const leaseUuid = '019e6f08-a59a-7001-9f12-3a0963d3f193';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex').toUpperCase();

function memoryJournal() {
  let value: TransactionRecord | null = null;
  let locked = false;
  const written: TransactionRecord[] = [];
  const journal: TransactionJournal = {
    load: async () => structuredClone(value),
    create: async record => { assert.equal(value, null); value = structuredClone(record); written.push(structuredClone(record)); },
    replace: async record => { assert.ok(value); value = structuredClone(record); written.push(structuredClone(record)); },
    withLock: async (_, work) => { if (locked) throw new Error('locked'); locked = true; try { return await work(); } finally { locked = false; } },
  };
  return { journal, written };
}

async function fixture() {
  // Public Cosmos test mnemonic only; no production wallets or network access.
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', { prefix: 'manifest' });
  const [account] = await wallet.getAccounts();
  const registry = new Registry([...cosmosProtoRegistry, ...liftedinitProtoRegistry]);
  const offline = await SigningStargateClient.offline(wallet, { registry });
  const { journal, written } = memoryJournal();
  const calls = { simulate: 0, sign: 0, broadcast: 0, getTx: 0, chain: 0 };
  let time = Date.parse('2026-09-17T20:00:00.000Z');
  let sent = new Uint8Array();
  let committed = true;
  const lookup = (): TransactionLookup => ({ hash: hash(sent), tx: sent, code: 0, height: 100, gasUsed: 200_000n, gasWanted: 300_000n,
    events: [{ type: 'lease_created', attributes: [{ key: 'lease_uuid', value: leaseUuid }, { key: 'irrelevant', value: 'sentinel secret not to persist' }] }] });
  const client: TransactionTransport = {
    registry,
    getChainId: async () => { calls.chain++; return MAINNET.chainId; },
    getSequence: async () => ({ accountNumber: 42, sequence: 3 }),
    simulate: async () => { calls.simulate++; return 200_000; },
    sign: async (...args) => {
      calls.sign++; const intent = await journal.load('create-lease'); assert.equal(intent?.status, 'intent');
      return offline.sign(...args);
    },
    broadcastTxSync: async bytes => {
      calls.broadcast++; sent = Uint8Array.from(bytes);
      const signed = await journal.load('create-lease'); assert.equal(signed?.status, 'signed'); assert.equal(signed.transactionHash, hash(bytes));
      return hash(bytes);
    },
    getTx: async () => { calls.getTx++; return committed ? lookup() : null; },
  };
  const options: JournaledTransactionOptions = {
    id: 'create-lease', tenant: account.address, publicKey: account.pubkey, denom, maxFeeBase: '200000',
    messages: [{ typeUrl: CREATE, value: MsgCreateLease.fromPartial({ tenant: account.address, items: [{ skuUuid: leaseUuid, quantity: 1n, serviceName: 'refuge' }], metaHash: new Uint8Array(32).fill(10) }) }],
    client, journal, pollTimeoutMs: 10, pollIntervalMs: 2, now: () => time, wait: async ms => { time += ms; },
  };
  return { options, client, journal, written, calls, offline, lookup, setCommitted: (value: boolean) => { committed = value; }, getSent: () => sent };
}

test('real offline SDK signature is journaled before one broadcast and confirmed without saving private payloads', async () => {
  const f = await fixture();
  const result = await executeJournaledTransaction(f.options);
  assert.equal(result.status, 'committed');
  assert.equal(result.record.receipt?.leaseUuid, leaseUuid);
  assert.deepEqual(f.written.map(item => item.status), ['intent', 'signed', 'committed']);
  assert.deepEqual(result.record.fee, { amountBase: '150000', denom, gasLimit: '300000' });
  assert.equal(result.record.transactionHash, hash(f.getSent()));
  const serialized = JSON.stringify(f.written);
  assert.ok(!serialized.includes('sentinel'));
  assert.ok(!serialized.includes('signatures'));
  assert.ok(!serialized.includes(Buffer.from(f.getSent()).toString('base64')));
  assert.equal((await executeJournaledTransaction(f.options)).reconciled, true);
  assert.equal(f.calls.sign, 1); assert.equal(f.calls.broadcast, 1);
});

test('unknown broadcast is reconciled from the stored hash without a second signature or broadcast', async () => {
  const f = await fixture(); f.setCommitted(false);
  const broadcast = f.client.broadcastTxSync;
  f.client.broadcastTxSync = async bytes => { await broadcast(bytes); throw new Error('private network diagnostic'); };
  const first = await executeJournaledTransaction(f.options);
  assert.equal(first.status, 'uncertain'); assert.equal(first.record.status, 'signed');
  f.setCommitted(true);
  const second = await executeJournaledTransaction(f.options);
  assert.equal(second.status, 'committed'); assert.equal(second.reconciled, true);
  assert.equal(f.calls.sign, 1); assert.equal(f.calls.broadcast, 1); assert.equal(f.calls.simulate, 1);
});

test('read-only recovery handles create commit before orchestration saved its lease UUID', async () => {
  const f = await fixture(); f.setCommitted(false);
  await executeJournaledTransaction(f.options);
  f.setCommitted(true);
  // This object has no signer, public-key access, simulation or broadcast APIs.
  const result = await reconcileJournaledTransaction({ id: 'create-lease', journal: f.journal, client: { getChainId: f.client.getChainId, getTx: f.client.getTx }, now: f.options.now, wait: f.options.wait, pollTimeoutMs: 10 });
  assert.equal(result?.status, 'committed'); assert.equal(result?.record.receipt?.leaseUuid, leaseUuid);
  assert.equal(f.calls.sign, 1); assert.equal(f.calls.broadcast, 1);
});

test('intent without a hash is never signed again after signing failure or restart', async () => {
  const f = await fixture();
  f.client.sign = async () => { f.calls.sign++; throw new Error('private signer diagnostic'); };
  const result = await executeJournaledTransaction(f.options);
  assert.equal(result.status, 'requires_review'); assert.equal(result.reason, 'signing_not_completed');
  const retry = await executeJournaledTransaction(f.options);
  assert.equal(retry.reason, 'intent_without_hash'); assert.equal(f.calls.sign, 1); assert.equal(f.calls.broadcast, 0);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('failure to persist the signed hash prevents broadcast and blocks automatic re-signing', async () => {
  const f = await fixture();
  f.journal.replace = async () => { throw new Error('disk write failed'); };
  await assert.rejects(() => executeJournaledTransaction(f.options), /disk write failed/);
  assert.equal(f.calls.broadcast, 0);
  assert.equal((await executeJournaledTransaction(f.options)).status, 'requires_review');
  assert.equal(f.calls.sign, 1);
});

test('mutated signed body, fee and signature are rejected before any network mutation', async () => {
  for (const mutate of [
    (raw: TxRaw) => { raw.bodyBytes = Uint8Array.from([...raw.bodyBytes, 0]); },
    (raw: TxRaw) => { const auth = AuthInfo.decode(raw.authInfoBytes); auth.fee!.amount[0].amount = '999999'; raw.authInfoBytes = AuthInfo.encode(auth).finish(); },
    (raw: TxRaw) => { raw.signatures[0][0] ^= 1; },
  ]) {
    const f = await fixture(); const sign = f.client.sign;
    f.client.sign = async (...args) => { const raw = await sign(...args); mutate(raw); return raw; };
    await assert.rejects(() => executeJournaledTransaction(f.options), /signed_transaction_(envelope_mismatch|signature_invalid)/);
    assert.equal(f.calls.broadcast, 0); assert.equal((await f.journal.load('create-lease'))?.status, 'intent');
  }
});

test('fee ceilings, chain mismatch, message scope and changed intent stop signing', async () => {
  const fee = await fixture();
  await assert.rejects(() => executeJournaledTransaction({ ...fee.options, maxFeeBase: '149999' }), /fee_ceiling/);
  assert.equal(fee.calls.sign, 0); assert.equal(await fee.journal.load('create-lease'), null);
  const gas = await fixture(); gas.client.simulate = async () => 1_000_000;
  await assert.rejects(() => executeJournaledTransaction(gas.options), /gas_ceiling/);
  assert.equal(gas.calls.sign, 0);
  const chain = await fixture(); chain.client.getChainId = async () => 'manifest-ledger-testnet';
  await assert.rejects(() => executeJournaledTransaction(chain.options), /chain_mismatch/);
  assert.equal(chain.calls.sign, 0);
  const scope = await fixture(); (scope.options.messages[0].value as MsgCreateLease).items[0].quantity = 2n;
  await assert.rejects(() => executeJournaledTransaction(scope.options), /scope_mismatch/);
  assert.equal(scope.calls.sign, 0);
  const changed = await fixture(); changed.setCommitted(false); await executeJournaledTransaction(changed.options);
  await assert.rejects(() => executeJournaledTransaction({ ...changed.options, memo: 'changed' }), /existing_transaction_intent_mismatch/);
  assert.equal(changed.calls.sign, 1);
});

test('broadcast hash mismatch remains uncertain and confirmation hash/body mismatches never become committed', async () => {
  const f = await fixture(); const broadcast = f.client.broadcastTxSync;
  f.client.broadcastTxSync = async bytes => { await broadcast(bytes); return 'A'.repeat(64); };
  const result = await executeJournaledTransaction(f.options);
  assert.equal(result.status, 'uncertain'); assert.equal(result.reason, 'broadcast_hash_mismatch');
  assert.equal(f.calls.getTx, 0);
  f.client.getTx = async () => ({ ...f.lookup(), hash: 'B'.repeat(64) });
  await assert.rejects(() => executeJournaledTransaction(f.options), /confirmation_hash_mismatch/);
  assert.equal((await f.journal.load('create-lease'))?.status, 'signed');
  assert.equal(f.calls.sign, 1); assert.equal(f.calls.broadcast, 1);
});

test('a committed failed transaction retains its fee reservation and is never retried', async () => {
  const f = await fixture(); f.client.getTx = async () => ({ ...f.lookup(), code: 5 });
  const result = await executeJournaledTransaction(f.options);
  assert.equal(result.status, 'failed'); assert.equal(result.record.fee.amountBase, '150000');
  assert.equal((await executeJournaledTransaction(f.options)).status, 'failed');
  assert.equal(f.calls.sign, 1); assert.equal(f.calls.broadcast, 1);
});

test('durable filesystem journal has private modes and never reclaims an existing transaction lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'merovingian-journal-test-'));
  try {
    const journal = createTransactionJournal(directory);
    const f = await fixture();
    const result = await executeJournaledTransaction(f.options);
    await journal.withLock('create-lease', async () => {
      await journal.create(f.written[0]); await journal.replace(f.written[1]); await journal.replace(result.record);
    });
    assert.equal((await stat(join(directory, 'create-lease.json'))).mode & 0o777, 0o600);
    assert.equal((await journal.load('create-lease'))?.receipt?.leaseUuid, leaseUuid);
    await writeFile(join(directory, 'create-lease.json.lock'), '{"pid":999999,"token":"stale"}', { mode: 0o600 });
    await assert.rejects(() => journal.withLock('create-lease', async () => {}), /manual_review/);
    assert.equal(JSON.parse(await readFile(join(directory, 'create-lease.json.lock'), 'utf8')).token, 'stale');
    await assert.rejects(() => journal.load('../outside'), /invalid_transaction_journal/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
