import type { EncodeObject } from '@cosmjs/proto-signing';
import { parseAddress } from '@manifest-network/manifest-sdk';
import { MsgCreateLease, MsgSetItemCustomDomain } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/tx.js';
import { pubkeyToAddress } from 'cosmjs-amino-modern';
import { AuthInfo, SignDoc, TxBody, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx.js';
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys.js';
import { createHash, createPublicKey, ECDH, randomUUID, verify } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { MAINNET } from './mainnet-config.js';
import { PREVIEW_MAX_GAS, previewFee } from './mainnet-preview.js';

const CREATE = '/liftedinit.billing.v1.MsgCreateLease';
const DOMAIN = '/liftedinit.billing.v1.MsgSetItemCustomDomain';
const KEY_TYPE = '/cosmos.crypto.secp256k1.PubKey';
const uint = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const hash = z.string().regex(/^[A-F0-9]{64}$/);
const recordSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  chainId: z.literal(MAINNET.chainId), tenant: z.string(),
  fingerprint: hash, messageTypes: z.array(z.enum([CREATE, DOMAIN])).min(1).max(2),
  status: z.enum(['intent', 'signed', 'committed', 'failed']),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  fee: z.object({ amountBase: uint, denom: z.string(), gasLimit: uint }).strict(),
  signer: z.object({ accountNumber: uint, sequence: uint }).strict(),
  transactionHash: hash.nullable(),
  receipt: z.object({ code: z.number().int().nonnegative(), height: uint, gasUsed: uint, gasWanted: uint, leaseUuid: z.string().uuid().optional() }).strict().nullable(),
}).strict();
export type TransactionRecord = z.infer<typeof recordSchema>;
export interface TransactionJournal {
  load(id: string): Promise<TransactionRecord | null>;
  create(record: TransactionRecord): Promise<void>;
  replace(record: TransactionRecord): Promise<void>;
  withLock<T>(id: string, work: () => Promise<T>): Promise<T>;
}
export interface TransactionLookup {
  hash: string; tx: Uint8Array; code: number; height: number; gasUsed: bigint; gasWanted: bigint;
  events: readonly { type: string; attributes: readonly { key: string; value: string }[] }[];
}
export interface TransactionTransport {
  registry: { encodeAsAny(message: EncodeObject): { typeUrl: string; value: Uint8Array } };
  getChainId(): Promise<string>;
  getSequence(address: string): Promise<{ accountNumber: number; sequence: number }>;
  simulate(address: string, messages: readonly EncodeObject[], memo: string): Promise<number>;
  sign(address: string, messages: readonly EncodeObject[], fee: { amount: { amount: string; denom: string }[]; gas: string }, memo: string, signerData: { accountNumber: number; sequence: number; chainId: string }, timeoutHeight?: bigint): Promise<TxRaw>;
  broadcastTxSync(bytes: Uint8Array): Promise<string>;
  getTx(hash: string): Promise<TransactionLookup | null>;
}
export interface JournaledTransactionOptions {
  id: string; messages: readonly EncodeObject[]; memo?: string; maxFeeBase: string;
  denom: string; tenant: string; publicKey: Uint8Array;
  client: TransactionTransport; journal: TransactionJournal;
  maxGas?: number; pollTimeoutMs?: number; pollIntervalMs?: number;
  // Deterministic test clock only. Production callers should omit both.
  now?: () => number; wait?: (ms: number) => Promise<void>;
}
export interface ReconcileTransactionOptions {
  id: string; client: Pick<TransactionTransport, 'getChainId' | 'getTx'>; journal: TransactionJournal;
  pollTimeoutMs?: number; pollIntervalMs?: number; now?: () => number; wait?: (ms: number) => Promise<void>;
}
export type JournaledTransactionResult = {
  status: 'committed' | 'failed' | 'uncertain' | 'requires_review';
  record: TransactionRecord;
  reconciled: boolean;
  reason?: 'intent_without_hash' | 'transaction_not_confirmed' | 'broadcast_hash_mismatch' | 'signing_not_completed';
};
export class TransactionError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'TransactionError'; }
}
const fail = (code: string): never => { throw new TransactionError(code); };
const txHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const equal = (left: Uint8Array, right: Uint8Array) => Buffer.from(left).equals(Buffer.from(right));

function validId(id: string) { if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) fail('invalid_transaction_id'); }
function checkedRecord(value: unknown): TransactionRecord {
  try {
    const record = recordSchema.parse(value);
    if (record.status === 'intent' && (record.transactionHash !== null || record.receipt !== null)) throw new Error();
    if (record.status !== 'intent' && !record.transactionHash) throw new Error();
    if (['committed', 'failed'].includes(record.status) !== Boolean(record.receipt)) throw new Error();
    if (record.receipt && (record.status === 'committed') !== (record.receipt.code === 0)) throw new Error();
    return record;
  } catch { return fail('invalid_transaction_journal'); }
}

/** Public records only. Files and their directory entries are fsynced before return. */
export function createTransactionJournal(directory: string): TransactionJournal {
  const directoryPath = resolve(directory);
  const path = (id: string) => { validId(id); return resolve(directoryPath, `${id}.json`); };
  const syncDirectory = async () => { const handle = await open(directoryPath, 'r'); try { await handle.sync(); } finally { await handle.close(); } };
  const write = async (filename: string, data: unknown) => {
    const handle = await open(filename, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
  };
  const load = async (id: string) => {
    try { return checkedRecord(JSON.parse(await readFile(path(id), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new TransactionError('invalid_transaction_journal'); }
  };
  return {
    load,
    async create(record) {
      await mkdir(directoryPath, { recursive: true, mode: 0o700 });
      try { await write(path(record.id), checkedRecord(record)); await syncDirectory(); }
      catch { throw new TransactionError('transaction_intent_persistence_failed'); }
    },
    async replace(record) {
      const value = checkedRecord(record);
      const existing = await load(record.id);
      if (!existing || existing.fingerprint !== value.fingerprint || existing.createdAt !== value.createdAt
        || (existing.transactionHash && existing.transactionHash !== value.transactionHash)
        || !(existing.status === 'intent' && value.status === 'signed' || existing.status === 'signed' && ['committed', 'failed'].includes(value.status))) fail('transaction_journal_transition_rejected');
      const temporary = `${path(record.id)}.${randomUUID()}.tmp`;
      try { await write(temporary, value); await rename(temporary, path(record.id)); await syncDirectory(); }
      catch { throw new TransactionError('transaction_journal_persistence_failed'); }
    },
    async withLock(id, work) {
      const lock = `${path(id)}.lock`;
      const token = randomUUID();
      await mkdir(directoryPath, { recursive: true, mode: 0o700 });
      try { await write(lock, { token, pid: process.pid }); await syncDirectory(); }
      catch { throw new TransactionError('transaction_locked_requires_manual_review'); }
      try { return await work(); }
      finally {
        // Never delete another process's lock or automatically reclaim a stale
        // one. Crash recovery requires inspecting the journal and lock locally.
        try {
          if ((JSON.parse(await readFile(lock, 'utf8')) as { token?: string }).token === token) { await unlink(lock); await syncDirectory(); }
        } catch { /* A surviving lock safely prevents another signing attempt. */ }
      }
    },
  };
}

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TransactionError('transaction_operation_timed_out')), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}

function transactionSpec(options: Pick<JournaledTransactionOptions, 'id' | 'messages' | 'memo' | 'maxFeeBase' | 'denom' | 'tenant' | 'publicKey' | 'maxGas'> & { client: Pick<TransactionTransport, 'registry'> }) {
  validId(options.id);
  const memo = options.memo ?? '';
  if (memo.length > 128 || /[\x00-\x1f]/.test(memo) || !/^[1-9][0-9]{0,19}$/.test(options.maxFeeBase)) fail('invalid_transaction_policy');
  const maxGas = options.maxGas ?? PREVIEW_MAX_GAS;
  // Reuses the exact integer gas/fee policy from the separately reviewed preview.
  previewFee(1, options.denom, maxGas);
  const tenant = parseAddress(options.tenant);
  const publicKey = Uint8Array.from(options.publicKey);
  let verificationKey: ReturnType<typeof createPublicKey>;
  try {
    if (publicKey.length !== 33 || ![2, 3].includes(publicKey[0])
      || pubkeyToAddress({ type: 'tendermint/PubKeySecp256k1', value: Buffer.from(publicKey).toString('base64') }, 'manifest') !== tenant) throw new Error();
    const point = ECDH.convertKey(publicKey, 'secp256k1', undefined, undefined, 'uncompressed');
    if (!Buffer.isBuffer(point)) throw new Error();
    verificationKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'secp256k1', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
  } catch { return fail('transaction_public_key_mismatch'); }
  if (options.messages.length !== 1) fail('transaction_requires_one_approved_message');
  const messages = structuredClone(options.messages);
  const encoded = messages.map(message => {
    if (![CREATE, DOMAIN].includes(message.typeUrl)) fail('transaction_message_type_not_allowed');
    const item = options.client.registry.encodeAsAny(message);
    if (item.typeUrl !== message.typeUrl || item.value.length > 16_384) fail('invalid_transaction_message');
    if (item.typeUrl === CREATE) {
      const value = MsgCreateLease.decode(item.value);
      if (value.tenant !== tenant || value.items.length !== 1 || value.items[0].quantity !== 1n || value.items[0].serviceName !== 'refuge' || value.metaHash.length !== 32) fail('transaction_message_scope_mismatch');
    } else {
      const value = MsgSetItemCustomDomain.decode(item.value);
      if (value.sender !== tenant || value.customDomain !== MAINNET.domain || value.serviceName !== 'refuge'
        || !z.string().uuid().safeParse(value.leaseUuid).success || value.leaseUuid === '00000000-0000-4000-8000-000000000000') fail('transaction_message_scope_mismatch');
    }
    return { typeUrl: item.typeUrl, value: Uint8Array.from(item.value) };
  });
  const expectedBody = TxBody.encode(TxBody.fromPartial({ messages: encoded, memo })).finish();
  const fingerprint = txHash(Buffer.from(JSON.stringify({ chainId: MAINNET.chainId, tenant, denom: options.denom, publicKey: Buffer.from(publicKey).toString('base64'), body: Buffer.from(expectedBody).toString('base64') })));
  return { tenant, messages, encoded, expectedBody, fingerprint, publicKey, verificationKey, memo, maxGas };
}

/** Reconstruct public intent from a committed tx, never from a new signing request. */
function recoveredSpec(found: TransactionLookup, record: TransactionRecord): TransactionSpec {
  try {
    const raw = TxRaw.decode(found.tx);
    const body = TxBody.decode(raw.bodyBytes);
    const auth = AuthInfo.decode(raw.authInfoBytes);
    if (auth.signerInfos.length !== 1 || auth.signerInfos[0].publicKey?.typeUrl !== KEY_TYPE) throw new Error();
    const publicKey = PubKey.decode(auth.signerInfos[0].publicKey.value).key;
    const messages = body.messages.map(message => {
      if (message.typeUrl === CREATE) return { typeUrl: CREATE, value: MsgCreateLease.decode(message.value) };
      if (message.typeUrl === DOMAIN) return { typeUrl: DOMAIN, value: MsgSetItemCustomDomain.decode(message.value) };
      throw new Error();
    });
    const spec = transactionSpec({ id: record.id, messages, memo: body.memo, maxFeeBase: record.fee.amountBase,
      denom: record.fee.denom, tenant: record.tenant, publicKey, client: { registry: { encodeAsAny(message) {
        if (message.typeUrl === CREATE) return { typeUrl: CREATE, value: MsgCreateLease.encode(message.value).finish() };
        return { typeUrl: DOMAIN, value: MsgSetItemCustomDomain.encode(message.value).finish() };
      } } } });
    if (spec.fingerprint !== record.fingerprint) throw new Error();
    return spec;
  } catch { return fail('recovered_transaction_intent_mismatch'); }
}

/** Explicit crash recovery: its transport has no signing or broadcast capability. */
export async function reconcileJournaledTransaction(options: ReconcileTransactionOptions): Promise<JournaledTransactionResult | null> {
  validId(options.id);
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (ms => new Promise(resolveWait => setTimeout(resolveWait, ms)));
  const pollTimeout = options.pollTimeoutMs ?? 45_000, interval = options.pollIntervalMs ?? 1500;
  if (!Number.isInteger(pollTimeout) || pollTimeout < 1 || pollTimeout > 60_000 || !Number.isInteger(interval) || interval < 1 || interval > 5000) fail('invalid_transaction_poll_policy');
  return options.journal.withLock(options.id, async () => {
    const record = await options.journal.load(options.id);
    if (!record) return null;
    checkedRecord(record);
    if (record.status === 'committed' || record.status === 'failed') return { status: record.status, record, reconciled: true };
    if (!record.transactionHash) return { status: 'requires_review', record, reconciled: true, reason: 'intent_without_hash' };
    try { if (await bounded(options.client.getChainId(), 10_000) !== MAINNET.chainId) fail('transaction_chain_mismatch'); }
    catch { return fail('transaction_chain_verification_failed'); }
    const deadline = now() + pollTimeout;
    while (now() < deadline) {
      let found: TransactionLookup | null = null;
      try { found = await bounded(options.client.getTx(record.transactionHash), Math.max(1, Math.min(5000, deadline - now()))); }
      catch { /* Absence or a read failure does not authorize another transaction. */ }
      if (found) {
        const committed = confirmedRecord(found, record, recoveredSpec(found, record), now());
        await options.journal.replace(committed);
        return { status: committed.status as 'committed' | 'failed', record: committed, reconciled: true };
      }
      const remaining = deadline - now();
      if (remaining > 0) await wait(Math.min(interval, remaining));
    }
    return { status: 'uncertain', record, reconciled: true, reason: 'transaction_not_confirmed' };
  });
}
type TransactionSpec = ReturnType<typeof transactionSpec>;

function assertSignedEnvelope(raw: TxRaw, spec: TransactionSpec, record: TransactionRecord) {
  const expectedAuth = AuthInfo.encode(AuthInfo.fromPartial({
    signerInfos: [{ publicKey: { typeUrl: KEY_TYPE, value: PubKey.encode({ key: spec.publicKey }).finish() }, modeInfo: { single: { mode: 1 } }, sequence: BigInt(record.signer.sequence) }],
    fee: { amount: [{ amount: record.fee.amountBase, denom: record.fee.denom }], gasLimit: BigInt(record.fee.gasLimit), payer: '', granter: '' },
  })).finish();
  if (!equal(raw.bodyBytes, spec.expectedBody) || !equal(raw.authInfoBytes, expectedAuth) || raw.signatures.length !== 1 || raw.signatures[0].length !== 64) fail('signed_transaction_envelope_mismatch');
  const signBytes = SignDoc.encode({ bodyBytes: raw.bodyBytes, authInfoBytes: raw.authInfoBytes, chainId: MAINNET.chainId, accountNumber: BigInt(record.signer.accountNumber) }).finish();
  if (!verify('sha256', signBytes, { key: spec.verificationKey, dsaEncoding: 'ieee-p1363' }, raw.signatures[0])) fail('signed_transaction_signature_invalid');
}

function assertRecordMatches(record: TransactionRecord, spec: TransactionSpec, options: JournaledTransactionOptions) {
  checkedRecord(record);
  if (record.id !== options.id || record.tenant !== spec.tenant || record.fingerprint !== spec.fingerprint
    || record.fee.denom !== options.denom || BigInt(record.fee.amountBase) > BigInt(options.maxFeeBase)
    || BigInt(record.fee.gasLimit) > BigInt(spec.maxGas)) fail('existing_transaction_intent_mismatch');
}

function confirmedRecord(found: TransactionLookup, record: TransactionRecord, spec: TransactionSpec, now: number): TransactionRecord {
  if (found.hash.toUpperCase() !== record.transactionHash || txHash(found.tx) !== record.transactionHash) fail('transaction_confirmation_hash_mismatch');
  assertSignedEnvelope(TxRaw.decode(found.tx), spec, record);
  if (!Number.isSafeInteger(found.code) || found.code < 0 || !Number.isSafeInteger(found.height) || found.height <= 0 || found.gasUsed < 0n || found.gasWanted < 0n) fail('invalid_transaction_confirmation');
  const leases = new Set<string>();
  for (const event of found.events) {
    if (!event.type.toLowerCase().includes('lease')) continue;
    for (const attr of event.attributes) {
      const value = attr.value.replace(/^"|"$/g, '');
      if (['lease_uuid', 'uuid'].includes(attr.key) && z.string().uuid().safeParse(value).success) leases.add(value);
    }
  }
  return checkedRecord({ ...record, status: found.code === 0 ? 'committed' : 'failed', updatedAt: new Date(now).toISOString(), receipt: {
    code: found.code, height: String(found.height), gasUsed: String(found.gasUsed), gasWanted: String(found.gasWanted),
    ...(leases.size === 1 ? { leaseUuid: [...leases][0] } : {}),
  } });
}

/** One signature and one broadcast at most. An existing intent is never replayed. */
export async function executeJournaledTransaction(options: JournaledTransactionOptions): Promise<JournaledTransactionResult> {
  const spec = transactionSpec(options);
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (ms => new Promise(resolveWait => setTimeout(resolveWait, ms)));
  const pollTimeout = options.pollTimeoutMs ?? 45_000;
  const interval = options.pollIntervalMs ?? 1500;
  if (!Number.isInteger(pollTimeout) || pollTimeout < 1 || pollTimeout > 60_000 || !Number.isInteger(interval) || interval < 1 || interval > 5000) fail('invalid_transaction_poll_policy');
  return options.journal.withLock(options.id, async () => {
    let record = await options.journal.load(options.id);
    let reconciled = Boolean(record);
    if (record) {
      assertRecordMatches(record, spec, options);
      if (record.status === 'committed' || record.status === 'failed') return { status: record.status, record, reconciled: true };
      if (!record.transactionHash) return { status: 'requires_review', record, reconciled: true, reason: 'intent_without_hash' };
    }
    let chainId: string;
    try { chainId = await bounded(options.client.getChainId(), 10_000); }
    catch { return fail('transaction_chain_verification_failed'); }
    if (chainId !== MAINNET.chainId) fail('transaction_chain_mismatch');
    if (!record) {
      let simulated: number, sequence: { accountNumber: number; sequence: number };
      try {
        simulated = await bounded(options.client.simulate(spec.tenant, spec.messages, spec.memo), 15_000);
        sequence = await bounded(options.client.getSequence(spec.tenant), 10_000);
      } catch { return fail('transaction_preparation_query_failed'); }
      if (![sequence.accountNumber, sequence.sequence].every(value => Number.isSafeInteger(value) && value >= 0)) fail('invalid_transaction_account_sequence');
      const fee = previewFee(simulated, options.denom, spec.maxGas);
      if (BigInt(fee.amountBase) > BigInt(options.maxFeeBase)) fail('transaction_fee_ceiling_exceeded');
      record = checkedRecord({ version: 1, id: options.id, chainId: MAINNET.chainId, tenant: spec.tenant, fingerprint: spec.fingerprint, messageTypes: spec.messages.map(item => item.typeUrl), status: 'intent',
        createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(), fee: { amountBase: fee.amountBase, denom: options.denom, gasLimit: fee.gasLimit },
        signer: { accountNumber: String(sequence.accountNumber), sequence: String(sequence.sequence) }, transactionHash: null, receipt: null });
      await options.journal.create(record);
      let raw: TxRaw;
      try {
        raw = structuredClone(await bounded(options.client.sign(spec.tenant, spec.messages, { amount: [{ amount: fee.amountBase, denom: options.denom }], gas: fee.gasLimit }, spec.memo, { ...sequence, chainId: MAINNET.chainId }, 0n), 20_000));
      } catch { return { status: 'requires_review', record, reconciled: false, reason: 'signing_not_completed' }; }
      assertSignedEnvelope(raw, spec, record);
      const bytes = TxRaw.encode(raw).finish();
      record = { ...record, status: 'signed', transactionHash: txHash(bytes), updatedAt: new Date(now()).toISOString() };
      // A durable public hash is the recovery key. Signed bytes and signatures
      // deliberately never enter the journal, logs, or returned result.
      await options.journal.replace(record);
      const deadline = now() + pollTimeout;
      try {
        const returnedHash = await bounded(options.client.broadcastTxSync(bytes), Math.max(1, Math.min(10_000, deadline - now())));
        if (returnedHash.toUpperCase() !== record.transactionHash) return { status: 'uncertain', record, reconciled: false, reason: 'broadcast_hash_mismatch' };
      } catch { /* The network may already have accepted it. Reconcile by hash. */ }
      return poll(record, deadline, false);
    }
    return poll(record, now() + pollTimeout, reconciled);

    async function poll(current: TransactionRecord, deadline: number, wasReconciled: boolean): Promise<JournaledTransactionResult> {
      while (now() < deadline) {
        let found: TransactionLookup | null = null;
        try { found = await bounded(options.client.getTx(current.transactionHash!), Math.max(1, Math.min(5000, deadline - now()))); }
        catch { /* Read failures are unknown, never proof that no tx exists. */ }
        if (found) {
          const committed = confirmedRecord(found, current, spec, now());
          await options.journal.replace(committed);
          return { status: committed.status as 'committed' | 'failed', record: committed, reconciled: wasReconciled };
        }
        const remaining = deadline - now();
        if (remaining > 0) await wait(Math.min(interval, remaining));
      }
      return { status: 'uncertain', record: current, reconciled: wasReconciled, reason: 'transaction_not_confirmed' };
    }
  });
}
